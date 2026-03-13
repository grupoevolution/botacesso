const TelegramBot = require("node-telegram-bot-api");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const instancias = new Map();
const timersLead = new Map();

// ── TEMPO BRASILIA ───────────────────────────────────────────
function agora() { return new Date(Date.now() - 3 * 60 * 60 * 1000); }
function log(nome, msg) {
  const d = agora();
  const t = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    .map(n => String(n).padStart(2, "0")).join(":");
  console.log(`[${t}] [${nome}] ${msg}`);
}

// ── PLANOS ───────────────────────────────────────────────────
const DIAS_PLANO = { mensal: 30, trimestral: 90, anual: 365 };

// Dias para rmkt e remoção por plano (null = não agenda)
const EVENTOS_PLANO = {
  mensal:     { rmkt: 25,   remocao: 30  },
  trimestral: { rmkt: 86,   remocao: 90  },
  anual:      { rmkt: null, remocao: null },
};

function calcularExpiracao(plano) {
  return new Date(Date.now() + (DIAS_PLANO[plano] || 30) * 86400000);
}

// ── RESOLVER VARIAVEIS ───────────────────────────────────────
function resolver(texto, lead, link) {
  if (!texto) return "";
  const exp = lead?.dataExpiracao ? new Date(lead.dataExpiracao).toLocaleDateString("pt-BR") : "—";
  const planos = { mensal: "Mensal (30 dias)", trimestral: "Trimestral (90 dias)", anual: "Anual (365 dias)" };
  return texto
    .replace(/{nome}/g,        lead?.nomeCompleto || lead?.username || "você")
    .replace(/{plano}/g,       planos[lead?.plano] || lead?.plano || "")
    .replace(/{expiracao}/g,   exp)
    .replace(/{telegram_id}/g, lead?.telegramId || "")
    .replace(/{link}/g,        link || "");
}

// ── TECLADO INLINE ───────────────────────────────────────────
function montarTeclado(botoesJson) {
  if (!botoesJson) return null;
  let b; try { b = JSON.parse(botoesJson); } catch { return null; }
  if (!b?.length) return null;
  return {
    inline_keyboard: b.map(btn => {
      if (btn.url)              return [{ text: btn.label, url: btn.url }];
      if (btn.passo !== undefined) return [{ text: btn.label, callback_data: `passo:${btn.passo}` }];
      return [{ text: btn.label, callback_data: `btn:${btn.label}` }];
    }),
  };
}

// ── ENVIAR MENSAGEM ──────────────────────────────────────────
async function enviarMsg(bot, chatId, passo, lead, link) {
  const texto = resolver(passo.texto || "", lead, link);
  const teclado = montarTeclado(passo.botoes);
  const opts = { parse_mode: "HTML" };
  if (teclado) opts.reply_markup = teclado;
  try {
    if (passo.mediaUrl) {
      if (passo.mediaTipo === "foto")
        await bot.sendPhoto(chatId, passo.mediaUrl, { caption: texto, ...opts });
      else if (passo.mediaTipo === "video")
        await bot.sendVideo(chatId, passo.mediaUrl, { caption: texto, ...opts });
      else if (texto) await bot.sendMessage(chatId, texto, opts);
    } else if (texto) {
      await bot.sendMessage(chatId, texto, opts);
    }
  } catch (err) { log("ENVIO", `chatId ${chatId}: ${err.message}`); }
}

// ── GERAR LINK ÚNICO ─────────────────────────────────────────
async function gerarLinkUnico(bot, grupoId) {
  try {
    const r = await bot.createChatInviteLink(grupoId, {
      member_limit: 1,
      name: `acesso_${Date.now()}`,
    });
    return r.invite_link;
  } catch (err) { log("LINK", err.message); return null; }
}

// ── GERAR LINK MANUAL (painel, sem enviar) ───────────────────
async function gerarLinkManual(botId) {
  const inst = instancias.get(botId);
  if (!inst) return { ok: false, erro: "Bot offline" };
  const bc = await prisma.botAcesso.findUnique({ where: { id: botId } });
  if (!bc) return { ok: false, erro: "Bot não encontrado" };
  const link = await gerarLinkUnico(inst.bot, bc.grupoId);
  return link ? { ok: true, link } : { ok: false, erro: "Falha ao gerar" };
}

// ── REGISTRAR ACESSO ─────────────────────────────────────────
async function registrarAcesso(leadId, link) {
  const dataAcesso    = new Date();
  const lead          = await prisma.lead.findUnique({ where: { id: leadId } });
  const dataExpiracao = calcularExpiracao(lead.plano);
  await prisma.lead.update({
    where: { id: leadId },
    data: { acessoConcedido: true, linkAcesso: link, dataAcesso, dataExpiracao, status: "ativo" },
  });
  return dataExpiracao;
}

// ── CONCEDER ACESSO (painel manual) ─────────────────────────
async function concederAcesso(botId, leadId) {
  const inst = instancias.get(botId);
  if (!inst) return { ok: false, erro: "Bot offline" };

  const [lead, bc] = await Promise.all([
    prisma.lead.findUnique({ where: { id: leadId } }),
    prisma.botAcesso.findUnique({ where: { id: botId } }),
  ]);
  if (!lead || !bc) return { ok: false, erro: "Não encontrado" };

  const link = await gerarLinkUnico(inst.bot, bc.grupoId);
  if (!link) return { ok: false, erro: "Falha ao gerar link" };

  const dataExpiracao = await registrarAcesso(leadId, link);
  const leadAtual = await prisma.lead.findUnique({ where: { id: leadId } });

  const msgAcesso = await prisma.mensagemAgendada.findFirst({
    where: { botId, nome: "acesso", ativa: true },
    orderBy: { ordem: "asc" },
  });

  await enviarMsg(inst.bot, parseInt(lead.telegramId), {
    texto: msgAcesso?.texto ||
      `Seu acesso foi liberado!\n\n<b>Link de entrada:</b> {link}\n\n<b>Plano:</b> {plano}\n<b>Valido ate:</b> {expiracao}`,
    mediaUrl: msgAcesso?.mediaUrl, mediaTipo: msgAcesso?.mediaTipo, botoes: msgAcesso?.botoes,
  }, leadAtual, link);

  await prisma.mensagemEnviada.create({ data: { leadId, tipo: "acesso" } });
  log(bc.nome, `Acesso manual concedido — lead ${leadId} [${lead.plano}]`);
  agendarEventosPlano(botId, leadId);
  return { ok: true, link };
}

// ── AGENDAR EVENTOS POR PLANO ────────────────────────────────
async function agendarEventosPlano(botId, leadId) {
  if (timersLead.has(leadId)) timersLead.get(leadId).forEach(t => clearTimeout(t));

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead?.dataAcesso) return;

  const inst = instancias.get(botId);
  if (!inst) return;

  const eventos  = EVENTOS_PLANO[lead.plano] || {};
  const timers   = [];
  const dataBase = new Date(lead.dataAcesso);

  // Horário de envio padrão: 10h Brasília = 13h UTC
  function calcAlvo(dias, horaUTC) {
    const alvo = new Date(dataBase.getTime() + dias * 86400000);
    alvo.setUTCHours(horaUTC, 0, 0, 0);
    return alvo;
  }

  // ── RMKT automático por plano ──
  if (eventos.rmkt) {
    const alvo  = calcAlvo(eventos.rmkt, 13);
    const msAte = alvo.getTime() - Date.now();
    if (msAte > 0) {
      const t = setTimeout(async () => {
        const leadAtual = await prisma.lead.findUnique({ where: { id: leadId } });
        if (!leadAtual || leadAtual.status === "removido") return;

        const nomeRmkt = `rmkt_${lead.plano}`;
        const msgRmkt  = await prisma.mensagemAgendada.findFirst({ where: { botId, nome: nomeRmkt, ativa: true } });

        await enviarMsg(inst.bot, parseInt(leadAtual.telegramId), {
          texto:     msgRmkt?.texto || `Oi {nome}! Seu acesso expira em breve. Renove agora para continuar tendo acesso!`,
          mediaUrl:  msgRmkt?.mediaUrl,
          mediaTipo: msgRmkt?.mediaTipo,
          botoes:    msgRmkt?.botoes,
        }, leadAtual);

        await prisma.mensagemEnviada.create({ data: { leadId, tipo: "rmkt" } });
        log(inst.nome, `Rmkt ${lead.plano} enviado — lead ${leadId}`);
      }, msAte);
      timers.push(t);
      log(inst.nome, `Lead ${leadId} [${lead.plano}]: rmkt em ${Math.round(msAte / 3600000)}h`);
    }
  }

  // ── Remoção automática por plano ──
  if (eventos.remocao) {
    const alvo  = calcAlvo(eventos.remocao, 14);
    const msAte = alvo.getTime() - Date.now();
    if (msAte > 0) {
      const t = setTimeout(async () => {
        const leadAtual = await prisma.lead.findUnique({ where: { id: leadId } });
        if (!leadAtual || leadAtual.status === "removido") return;
        await removerDoGrupo(botId, leadId, true);
      }, msAte);
      timers.push(t);
      log(inst.nome, `Lead ${leadId} [${lead.plano}]: remocao em ${Math.round(msAte / 3600000)}h`);
    }
  }

  // ── Mensagens agendadas extras configuradas no painel ──
  const msgsCustom = await prisma.mensagemAgendada.findMany({
    where: { botId, ativa: true, NOT: [{ nome: "acesso" }, { nome: "remocao" }] },
    orderBy: { diaEnvio: "asc" },
  });

  for (const msg of msgsCustom) {
    // Pula os nomes de rmkt que já foram agendados acima
    if (msg.nome === `rmkt_${lead.plano}`) continue;

    const [hh, mm] = (msg.horario || "10:00").split(":").map(Number);
    const alvo     = new Date(dataBase.getTime() + msg.diaEnvio * 86400000);
    alvo.setUTCHours(hh + 3, mm, 0, 0);
    const msAte = alvo.getTime() - Date.now();
    if (msAte <= 0) continue;

    const t = setTimeout(async () => {
      const leadAtual = await prisma.lead.findUnique({ where: { id: leadId } });
      if (!leadAtual || leadAtual.status === "removido") return;

      if (msg.nome === "rmkt_remocao") {
        await removerDoGrupo(botId, leadId, true);
        return;
      }

      await enviarMsg(inst.bot, parseInt(leadAtual.telegramId), {
        texto: msg.texto || "", mediaUrl: msg.mediaUrl, mediaTipo: msg.mediaTipo, botoes: msg.botoes,
      }, leadAtual);

      await prisma.mensagemEnviada.create({ data: { leadId, mensagemAgendadaId: msg.id, tipo: "agendada" } });
      log(inst.nome, `"${msg.nome}" enviado — lead ${leadId}`);
    }, msAte);

    timers.push(t);
  }

  timersLead.set(leadId, timers);
}

// ── PROCESSAR PASSO DO FUNIL ─────────────────────────────────
async function processarMensagem(bot, chatId, lead, gatilho, botConfig) {
  const funil = await prisma.funilAcesso.findUnique({
    where: { botId: lead.botId },
    include: { passos: { orderBy: { ordem: "asc" } } },
  });
  if (!funil?.passos?.length) return;

  // Encontra próximo passo compatível com o gatilho
  const restantes = funil.passos.filter(p => p.ordem >= lead.passoFunil);
  let passo = null;
  for (const p of restantes) {
    const g = p.gatilho || "qualquer";
    if (g === "qualquer")                                        { passo = p; break; }
    if (g === "inicio" && gatilho === "inicio")                  { passo = p; break; }
    if (g.startsWith("botao:") && gatilho === g.replace("botao:", "")) { passo = p; break; }
  }
  if (!passo) return;

  if (passo.delay > 0) {
    await bot.sendChatAction(chatId, "typing").catch(() => {});
    await new Promise(r => setTimeout(r, passo.delay * 1000));
  }

  // Se o passo usa {link} e o bot é pago e o lead ainda não tem acesso → gera e registra
  let linkGerado = null;
  if (passo.texto?.includes("{link}") && botConfig.tipo === "pago" && !lead.acessoConcedido) {
    linkGerado = await gerarLinkUnico(bot, botConfig.grupoId);
    if (linkGerado) {
      await registrarAcesso(lead.id, linkGerado);
      await prisma.mensagemEnviada.create({ data: { leadId: lead.id, tipo: "acesso" } });
      log(botConfig.nome, `Acesso automatico — lead ${lead.id} [${lead.plano}]`);
      setTimeout(() => agendarEventosPlano(lead.botId, lead.id), 500);
    }
  }

  const leadAtual = await prisma.lead.findUnique({ where: { id: lead.id } });
  await enviarMsg(bot, chatId, {
    texto: passo.texto, mediaUrl: passo.mediaUrl, mediaTipo: passo.mediaTipo, botoes: passo.botoes,
  }, leadAtual, linkGerado || lead.linkAcesso);

  await prisma.mensagemEnviada.create({ data: { leadId: lead.id, tipo: "funil" } });

  const proximaOrdem = passo.ordem + 1;
  await prisma.lead.update({
    where: { id: lead.id },
    data: { passoFunil: funil.passos.some(p => p.ordem === proximaOrdem) ? proximaOrdem : passo.ordem },
  });
}

async function processarCallback(bot, query, lead, botConfig) {
  const data = query.data || "";
  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (data.startsWith("passo:")) {
    const ordemAlvo = parseInt(data.replace("passo:", ""));
    const funil = await prisma.funilAcesso.findUnique({
      where: { botId: lead.botId },
      include: { passos: { orderBy: { ordem: "asc" } } },
    });
    const passo = funil?.passos?.find(p => p.ordem === ordemAlvo);
    if (!passo) return;
    if (passo.delay > 0) {
      await bot.sendChatAction(query.message.chat.id, "typing").catch(() => {});
      await new Promise(r => setTimeout(r, passo.delay * 1000));
    }
    const leadAtual = await prisma.lead.findUnique({ where: { id: lead.id } });
    await enviarMsg(bot, query.message.chat.id, {
      texto: passo.texto, mediaUrl: passo.mediaUrl, mediaTipo: passo.mediaTipo, botoes: passo.botoes,
    }, leadAtual);
    await prisma.mensagemEnviada.create({ data: { leadId: lead.id, tipo: "funil" } });
    await prisma.lead.update({
      where: { id: lead.id },
      data: { passoFunil: funil.passos.some(p => p.ordem === ordemAlvo + 1) ? ordemAlvo + 1 : ordemAlvo },
    });
  } else if (data.startsWith("btn:")) {
    await processarMensagem(bot, query.message.chat.id, lead, `botao:${data.replace("btn:", "")}`, botConfig);
  }
}

// ── ACESSO TEMPORÁRIO (free) ─────────────────────────────────
async function concederAcessoTemporario(botId, leadId, minutos) {
  const inst = instancias.get(botId);
  if (!inst) return { ok: false, erro: "Bot offline" };
  const [lead, bc] = await Promise.all([
    prisma.lead.findUnique({ where: { id: leadId } }),
    prisma.botAcesso.findUnique({ where: { id: botId } }),
  ]);
  if (!lead || !bc) return { ok: false, erro: "Não encontrado" };
  const link = await gerarLinkUnico(inst.bot, bc.grupoId);
  if (!link) return { ok: false, erro: "Falha ao gerar link" };

  await enviarMsg(inst.bot, parseInt(lead.telegramId), {
    texto: `Aqui está seu acesso de <b>${minutos} minutos</b> para conhecer o grupo:\n\n${link}\n\n⚠️ Expira em ${minutos} minutos!`,
  }, lead);

  setTimeout(async () => {
    try {
      await inst.bot.banChatMember(bc.grupoId, parseInt(lead.telegramId));
      await inst.bot.unbanChatMember(bc.grupoId, parseInt(lead.telegramId));
      await enviarMsg(inst.bot, parseInt(lead.telegramId), {
        texto: "Seu acesso de demonstração expirou.\n\nGostou? Garanta seu acesso completo agora!",
      }, lead);
    } catch (err) { log(inst.nome, `Erro remover temp: ${err.message}`); }
  }, minutos * 60000);

  return { ok: true, link };
}

// ── REMOVER DO GRUPO ─────────────────────────────────────────
async function removerDoGrupo(botId, leadId, enviarAviso) {
  const inst = instancias.get(botId);
  if (!inst) return false;
  const [lead, bc] = await Promise.all([
    prisma.lead.findUnique({ where: { id: leadId } }),
    prisma.botAcesso.findUnique({ where: { id: botId } }),
  ]);
  if (!lead || !bc) return false;

  if (enviarAviso) {
    const msg = await prisma.mensagemAgendada.findFirst({ where: { botId, nome: "remocao", ativa: true } });
    await enviarMsg(inst.bot, parseInt(lead.telegramId), {
      texto:     msg?.texto || "Seu acesso expirou e você foi removido do grupo.\n\nPara renovar clique abaixo.",
      mediaUrl:  msg?.mediaUrl, mediaTipo: msg?.mediaTipo, botoes: msg?.botoes,
    }, lead);
    await prisma.mensagemEnviada.create({ data: { leadId, tipo: "remocao" } });
  }

  try {
    await inst.bot.banChatMember(bc.grupoId, parseInt(lead.telegramId));
    await inst.bot.unbanChatMember(bc.grupoId, parseInt(lead.telegramId));
  } catch (err) { log(inst.nome, `Erro remover: ${err.message}`); }

  await prisma.lead.update({ where: { id: leadId }, data: { status: "removido" } });
  log(inst.nome, `Lead ${leadId} removido`);
  return true;
}

// ── RENOVAR ACESSO ───────────────────────────────────────────
async function renovarAcesso(leadId, plano) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return false;

  const novoPlano = plano || lead.plano;
  const novaExp   = calcularExpiracao(novoPlano);
  const agr       = new Date();

  await prisma.lead.update({
    where: { id: leadId },
    data: { plano: novoPlano, status: "ativo", dataAcesso: agr, dataExpiracao: novaExp, renovadoEm: agr },
  });

  const inst = instancias.get(lead.botId);
  if (lead.status === "removido" && inst) {
    const bc   = await prisma.botAcesso.findUnique({ where: { id: lead.botId } });
    const link = await gerarLinkUnico(inst.bot, bc.grupoId);
    if (link) {
      await prisma.lead.update({ where: { id: leadId }, data: { linkAcesso: link } });
      const leadAtual = await prisma.lead.findUnique({ where: { id: leadId } });
      await enviarMsg(inst.bot, parseInt(lead.telegramId), {
        texto: `Acesso renovado! Novo link:\n\n${link}\n\nPlano: ${novoPlano} — Valido ate ${novaExp.toLocaleDateString("pt-BR")}`,
      }, leadAtual, link);
    }
  }

  agendarEventosPlano(lead.botId, leadId);
  return true;
}

// ── INICIAR BOT ───────────────────────────────────────────────
async function iniciarBot(config) {
  if (instancias.has(config.id)) await pararBot(config.id);
  try {
    const bot = new TelegramBot(config.token, { polling: true });
    instancias.set(config.id, { bot, nome: config.nome, tipo: config.tipo, botId: config.id });
    log(config.nome, `Online (${config.tipo})`);

    bot.on("message", async (msg) => {
      if (msg.chat.type !== "private") return;
      const telegramId = String(msg.chat.id);
      const texto      = msg.text || "";

      let plano = "mensal";
      if (texto.startsWith("/start")) {
        const param = (texto.split(" ")[1] || "").toLowerCase();
        if (param.startsWith("p3m"))  plano = "trimestral";
        else if (param.startsWith("p12m")) plano = "anual";
        else plano = "mensal";
      }

      let lead = await prisma.lead.findUnique({
        where: { botId_telegramId: { botId: config.id, telegramId } },
      });

      if (!lead) {
        const nome = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
        lead = await prisma.lead.create({
          data: { botId: config.id, telegramId, username: msg.from?.username || null, nomeCompleto: nome || null, plano, status: "pendente" },
        });
        log(config.nome, `Novo lead: ${nome || telegramId} [${plano}]`);
      } else if (texto.startsWith("/start") && lead.plano !== plano && !lead.acessoConcedido) {
        await prisma.lead.update({ where: { id: lead.id }, data: { plano } });
        lead = { ...lead, plano };
        log(config.nome, `Lead ${lead.id} atualizou plano para ${plano}`);
      }

      await processarMensagem(bot, msg.chat.id, lead, texto.startsWith("/start") ? "inicio" : "qualquer", config);
    });

    bot.on("callback_query", async (query) => {
      const telegramId = String(query.from.id);
      const lead = await prisma.lead.findUnique({ where: { botId_telegramId: { botId: config.id, telegramId } } });
      if (lead) await processarCallback(bot, query, lead, config);
    });

    bot.on("polling_error", err => log(config.nome, `Polling: ${err.message}`));
    return true;
  } catch (err) { log(config.nome, `Falha: ${err.message}`); return false; }
}

async function pararBot(botId) {
  const inst = instancias.get(botId);
  if (!inst) return;
  try { await inst.bot.stopPolling(); } catch (_) {}
  instancias.delete(botId);
}

async function iniciarTodosBots() {
  const bots = await prisma.botAcesso.findMany({ where: { ativo: true } });
  for (const b of bots) await iniciarBot(b);
  const leads = await prisma.lead.findMany({ where: { acessoConcedido: true, status: "ativo" } });
  for (const l of leads) await agendarEventosPlano(l.botId, l.id);
  log("SISTEMA", `${bots.length} bots | ${leads.length} timers recarregados`);
}

function getStatus() {
  const s = {};
  for (const [id, i] of instancias.entries()) s[id] = { online: true, nome: i.nome };
  return s;
}

module.exports = {
  iniciarBot, pararBot, iniciarTodosBots, getStatus,
  concederAcesso, concederAcessoTemporario, removerDoGrupo,
  renovarAcesso, agendarEventosPlano, gerarLinkManual,
};
