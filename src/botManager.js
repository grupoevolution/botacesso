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
function calcularExpiracao(plano) {
  return new Date(Date.now() + (DIAS_PLANO[plano] || 30) * 86400000);
}

// ── RESOLVER VARIAVEIS NO TEXTO ──────────────────────────────
function resolver(texto, lead) {
  if (!texto) return "";
  const exp = lead?.dataExpiracao
    ? new Date(lead.dataExpiracao).toLocaleDateString("pt-BR") : "—";
  const planos = { mensal: "Mensal (30 dias)", trimestral: "Trimestral (90 dias)", anual: "Anual (365 dias)" };
  return texto
    .replace(/{nome}/g, lead?.nomeCompleto || lead?.username || "você")
    .replace(/{plano}/g, planos[lead?.plano] || lead?.plano || "")
    .replace(/{expiracao}/g, exp)
    .replace(/{telegram_id}/g, lead?.telegramId || "");
}

// ── MONTAR INLINE KEYBOARD ───────────────────────────────────
function montarTeclado(botoesJson, passos) {
  if (!botoesJson) return null;
  let botoes;
  try { botoes = JSON.parse(botoesJson); } catch { return null; }
  if (!botoes?.length) return null;

  const linhas = botoes.map(b => {
    if (b.url) return [{ text: b.label, url: b.url }];
    if (b.passo !== undefined) return [{ text: b.label, callback_data: `passo:${b.passo}` }];
    return [{ text: b.label, callback_data: `btn:${b.label}` }];
  });
  return { inline_keyboard: linhas };
}

// ── ENVIAR MENSAGEM COM BOTOES ───────────────────────────────
async function enviarMsg(bot, chatId, passo, lead) {
  const texto = lead ? resolver(passo.texto, lead) : (passo.texto || "");
  const teclado = montarTeclado(passo.botoes);
  const opts = { parse_mode: "HTML" };
  if (teclado) opts.reply_markup = teclado;

  try {
    if (passo.mediaUrl) {
      if (passo.mediaTipo === "foto")
        await bot.sendPhoto(chatId, passo.mediaUrl, { caption: texto, ...opts });
      else if (passo.mediaTipo === "video")
        await bot.sendVideo(chatId, passo.mediaUrl, { caption: texto, ...opts });
      else if (texto)
        await bot.sendMessage(chatId, texto, opts);
    } else if (texto) {
      await bot.sendMessage(chatId, texto, opts);
    }
  } catch (err) {
    log("ENVIO", `Erro chatId ${chatId}: ${err.message}`);
  }
}

// ── EXECUTAR PASSO DO FUNIL ──────────────────────────────────
async function executarPasso(bot, chatId, passo, lead) {
  if (passo.delay > 0) {
    await bot.sendChatAction(chatId, "typing").catch(() => {});
    await new Promise(r => setTimeout(r, passo.delay * 1000));
  }
  await enviarMsg(bot, chatId, passo, lead);
  await prisma.mensagemEnviada.create({ data: { leadId: lead.id, tipo: "funil" } });
}

// ── PROCESSAR MENSAGEM NO FUNIL ──────────────────────────────
async function processarMensagem(bot, chatId, lead, gatilhoTexto) {
  const funil = await prisma.funilAcesso.findUnique({
    where: { botId: lead.botId },
    include: { passos: { orderBy: { ordem: "asc" } } },
  });
  if (!funil?.passos?.length) return;

  // Procura próximo passo compatível com o gatilho
  const passosRestantes = funil.passos.filter(p => p.ordem >= lead.passoFunil);
  let passoAlvo = null;

  for (const p of passosRestantes) {
    const g = p.gatilho || "qualquer";
    if (g === "qualquer") { passoAlvo = p; break; }
    if (g === "inicio" && gatilhoTexto === "/start") { passoAlvo = p; break; }
    if (g.startsWith("botao:") && gatilhoTexto === g.replace("botao:", "")) { passoAlvo = p; break; }
  }

  if (!passoAlvo) return;

  await executarPasso(bot, chatId, passoAlvo, lead);

  // Avança o ponteiro para o próximo passo
  const proximaOrdem = passoAlvo.ordem + 1;
  const temProx = funil.passos.some(p => p.ordem === proximaOrdem);
  await prisma.lead.update({
    where: { id: lead.id },
    data: { passoFunil: temProx ? proximaOrdem : passoAlvo.ordem },
  });
}

// ── PROCESSAR CALLBACK (clique em botao) ────────────────────
async function processarCallback(bot, query, lead) {
  const data = query.data || "";
  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (data.startsWith("passo:")) {
    // Pula direto para um passo específico
    const ordemAlvo = parseInt(data.replace("passo:", ""));
    const funil = await prisma.funilAcesso.findUnique({
      where: { botId: lead.botId },
      include: { passos: { orderBy: { ordem: "asc" } } },
    });
    const passo = funil?.passos?.find(p => p.ordem === ordemAlvo);
    if (passo) {
      await executarPasso(bot, query.message.chat.id, passo, lead);
      const proximaOrdem = ordemAlvo + 1;
      const temProx = funil.passos.some(p => p.ordem === proximaOrdem);
      await prisma.lead.update({
        where: { id: lead.id },
        data: { passoFunil: temProx ? proximaOrdem : ordemAlvo },
      });
    }
  } else if (data.startsWith("btn:")) {
    // Clique em botão sem URL nem passo → trata como mensagem com o label
    const label = data.replace("btn:", "");
    await processarMensagem(bot, query.message.chat.id, lead, `botao:${label}`);
  }
}

// ── GERAR LINK UNICO ─────────────────────────────────────────
async function gerarLinkUnico(bot, grupoId) {
  try {
    const link = await bot.createChatInviteLink(grupoId, {
      member_limit: 1,
      name: `acesso_${Date.now()}`,
    });
    return link.invite_link;
  } catch (err) {
    log("LINK", `Erro: ${err.message}`);
    return null;
  }
}

// ── CONCEDER ACESSO ──────────────────────────────────────────
async function concederAcesso(botId, leadId) {
  const inst = instancias.get(botId);
  if (!inst) return { ok: false, erro: "Bot offline" };

  const [lead, botConfig] = await Promise.all([
    prisma.lead.findUnique({ where: { id: leadId } }),
    prisma.botAcesso.findUnique({ where: { id: botId } }),
  ]);
  if (!lead || !botConfig) return { ok: false, erro: "Não encontrado" };

  const link = await gerarLinkUnico(inst.bot, botConfig.grupoId);
  if (!link) return { ok: false, erro: "Falha ao gerar link" };

  const dataExpiracao = calcularExpiracao(lead.plano);
  const dataAcesso = new Date();

  await prisma.lead.update({
    where: { id: leadId },
    data: { acessoConcedido: true, linkAcesso: link, dataAcesso, dataExpiracao, status: "ativo" },
  });

  const leadAtual = await prisma.lead.findUnique({ where: { id: leadId } });

  // Mensagem de acesso configurada
  const msgAcesso = await prisma.mensagemAgendada.findFirst({
    where: { botId, nome: "acesso", ativa: true },
  });

  const textoAcesso = msgAcesso?.texto
    ? resolver(msgAcesso.texto, leadAtual).replace(/{link}/g, link)
    : `Seu acesso foi liberado!\n\n<b>Link de entrada:</b> ${link}\n\n<b>Plano:</b> ${lead.plano}\n<b>Válido até:</b> ${dataExpiracao.toLocaleDateString("pt-BR")}`;

  await enviarMsg(inst.bot, parseInt(lead.telegramId),
    { texto: textoAcesso, mediaUrl: msgAcesso?.mediaUrl, mediaTipo: msgAcesso?.mediaTipo, botoes: msgAcesso?.botoes },
    leadAtual);
  await prisma.mensagemEnviada.create({ data: { leadId, tipo: "acesso" } });

  log(inst.nome, `Acesso concedido — lead ${leadId} plano ${lead.plano}`);
  agendarMensagensLead(botId, leadId);
  return { ok: true, link };
}

// ── ACESSO TEMPORARIO (free) ─────────────────────────────────
async function concederAcessoTemporario(botId, leadId, minutos) {
  const inst = instancias.get(botId);
  if (!inst) return { ok: false, erro: "Bot offline" };

  const [lead, botConfig] = await Promise.all([
    prisma.lead.findUnique({ where: { id: leadId } }),
    prisma.botAcesso.findUnique({ where: { id: botId } }),
  ]);
  if (!lead || !botConfig) return { ok: false, erro: "Não encontrado" };

  const link = await gerarLinkUnico(inst.bot, botConfig.grupoId);
  if (!link) return { ok: false, erro: "Falha ao gerar link" };

  await enviarMsg(inst.bot, parseInt(lead.telegramId), {
    texto: `Aqui está seu acesso de <b>${minutos} minutos</b> para conhecer o grupo:\n\n${link}\n\n⚠️ O link expira em ${minutos} minutos!`,
  }, lead);

  setTimeout(async () => {
    try {
      await inst.bot.banChatMember(botConfig.grupoId, parseInt(lead.telegramId));
      await inst.bot.unbanChatMember(botConfig.grupoId, parseInt(lead.telegramId));
      await enviarMsg(inst.bot, parseInt(lead.telegramId), {
        texto: "Seu acesso de demonstração expirou.\n\nGostou do que viu? Garanta seu acesso completo agora!",
      }, lead);
    } catch (err) { log(inst.nome, `Erro remover temp: ${err.message}`); }
  }, minutos * 60000);

  return { ok: true, link };
}

// ── REMOVER DO GRUPO ─────────────────────────────────────────
async function removerDoGrupo(botId, leadId, enviarAviso) {
  const inst = instancias.get(botId);
  if (!inst) return false;

  const [lead, botConfig] = await Promise.all([
    prisma.lead.findUnique({ where: { id: leadId } }),
    prisma.botAcesso.findUnique({ where: { id: botId } }),
  ]);
  if (!lead || !botConfig) return false;

  if (enviarAviso) {
    const msgRem = await prisma.mensagemAgendada.findFirst({
      where: { botId, nome: "remocao", ativa: true },
    });
    await enviarMsg(inst.bot, parseInt(lead.telegramId), {
      texto: msgRem?.texto || "Seu acesso expirou e você foi removido do grupo.\n\nPara renovar clique abaixo.",
      mediaUrl: msgRem?.mediaUrl, mediaTipo: msgRem?.mediaTipo, botoes: msgRem?.botoes,
    }, lead);
    await prisma.mensagemEnviada.create({ data: { leadId, tipo: "remocao" } });
  }

  try {
    await inst.bot.banChatMember(botConfig.grupoId, parseInt(lead.telegramId));
    await inst.bot.unbanChatMember(botConfig.grupoId, parseInt(lead.telegramId));
  } catch (err) { log(inst.nome, `Erro remover: ${err.message}`); }

  await prisma.lead.update({ where: { id: leadId }, data: { status: "removido" } });
  log(inst.nome, `Lead ${leadId} removido`);
  return true;
}

// ── AGENDAR MENSAGENS DO LEAD ────────────────────────────────
async function agendarMensagensLead(botId, leadId) {
  if (timersLead.has(leadId)) {
    timersLead.get(leadId).forEach(t => clearTimeout(t));
  }

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead?.dataAcesso) return;

  const msgs = await prisma.mensagemAgendada.findMany({
    where: { botId, ativa: true, NOT: [{ nome: "acesso" }, { nome: "remocao" }] },
    orderBy: { diaEnvio: "asc" },
  });

  const inst = instancias.get(botId);
  if (!inst) return;

  const timers = [];
  for (const msg of msgs) {
    const [hh, mm] = (msg.horario || "10:00").split(":").map(Number);
    const alvo = new Date(new Date(lead.dataAcesso).getTime() + msg.diaEnvio * 86400000);
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
        texto: resolver(msg.texto || "", leadAtual),
        mediaUrl: msg.mediaUrl, mediaTipo: msg.mediaTipo, botoes: msg.botoes,
      }, leadAtual);

      await prisma.mensagemEnviada.create({
        data: { leadId, mensagemAgendadaId: msg.id, tipo: "agendada" },
      });
      log(inst.nome, `"${msg.nome}" enviado para lead ${leadId}`);
    }, msAte);

    timers.push(t);
  }
  timersLead.set(leadId, timers);
}

async function recarregarTimers() {
  const leads = await prisma.lead.findMany({ where: { acessoConcedido: true, status: "ativo" } });
  for (const l of leads) await agendarMensagensLead(l.botId, l.id);
  log("SISTEMA", `${leads.length} timers recarregados`);
}

// ── RENOVAR ──────────────────────────────────────────────────
async function renovarAcesso(leadId, plano) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return false;

  const novoPlano = plano || lead.plano;
  const novaExp = calcularExpiracao(novoPlano);
  const agr = new Date();

  await prisma.lead.update({
    where: { id: leadId },
    data: { plano: novoPlano, status: "ativo", dataAcesso: agr, dataExpiracao: novaExp, renovadoEm: agr },
  });

  const inst = instancias.get(lead.botId);
  if (lead.status === "removido" && inst) {
    const botConfig = await prisma.botAcesso.findUnique({ where: { id: lead.botId } });
    const novoLink = await gerarLinkUnico(inst.bot, botConfig.grupoId);
    if (novoLink) {
      await prisma.lead.update({ where: { id: leadId }, data: { linkAcesso: novoLink } });
      const leadAtual = await prisma.lead.findUnique({ where: { id: leadId } });
      await enviarMsg(inst.bot, parseInt(lead.telegramId), {
        texto: `Acesso renovado! Novo link:\n\n${novoLink}\n\nPlano: ${novoPlano} — válido até ${novaExp.toLocaleDateString("pt-BR")}`,
      }, leadAtual);
    }
  }

  agendarMensagensLead(lead.botId, leadId);
  return true;
}

// ── INICIAR BOT ───────────────────────────────────────────────
async function iniciarBot(config) {
  if (instancias.has(config.id)) await pararBot(config.id);

  try {
    const bot = new TelegramBot(config.token, { polling: true });
    instancias.set(config.id, { bot, nome: config.nome, tipo: config.tipo, botId: config.id });
    log(config.nome, `Online (${config.tipo})`);

    // Mensagens de texto
    bot.on("message", async (msg) => {
      if (msg.chat.type !== "private") return;
      const telegramId = String(msg.chat.id);
      const texto = msg.text || "";

      let plano = "mensal";
      if (texto.startsWith("/start")) {
        const param = (texto.split(" ")[1] || "").toLowerCase();
        if (param.startsWith("p3m")) plano = "trimestral";
        else if (param.startsWith("p12m")) plano = "anual";
      }

      let lead = await prisma.lead.findUnique({
        where: { botId_telegramId: { botId: config.id, telegramId } },
      });

      if (!lead) {
        const nomeCompleto = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
        lead = await prisma.lead.create({
          data: {
            botId: config.id, telegramId,
            username: msg.from?.username || null,
            nomeCompleto: nomeCompleto || null,
            plano, status: "pendente",
          },
        });
        log(config.nome, `Novo lead: ${nomeCompleto || telegramId} [${plano}]`);
      }

      const gatilho = texto.startsWith("/start") ? "inicio" : "qualquer";
      await processarMensagem(bot, msg.chat.id, lead, gatilho);
    });

    // Callbacks de botões
    bot.on("callback_query", async (query) => {
      const telegramId = String(query.from.id);
      const lead = await prisma.lead.findUnique({
        where: { botId_telegramId: { botId: config.id, telegramId } },
      });
      if (lead) await processarCallback(bot, query, lead);
    });

    bot.on("polling_error", err => log(config.nome, `Polling: ${err.message}`));
    return true;
  } catch (err) {
    log(config.nome, `Falha: ${err.message}`);
    return false;
  }
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
  await recarregarTimers();
}

function getStatus() {
  const s = {};
  for (const [id, i] of instancias.entries()) s[id] = { online: true, nome: i.nome };
  return s;
}

module.exports = {
  iniciarBot, pararBot, iniciarTodosBots, getStatus,
  concederAcesso, concederAcessoTemporario, removerDoGrupo,
  renovarAcesso, agendarMensagensLead,
};
