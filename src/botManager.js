const TelegramBot = require("node-telegram-bot-api");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const instancias = new Map(); // botId -> { bot, nome, tipo }

// ── TIMEZONE BRASILIA ────────────────────────────────────────
function agora() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}
function log(nome, msg) {
  const d = agora();
  const t = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    .map(n => String(n).padStart(2, "0")).join(":");
  console.log(`[${t}] [${nome}] ${msg}`);
}

// ── PLANOS ───────────────────────────────────────────────────
const DIAS_PLANO = { mensal: 30, trimestral: 90, anual: 365 };

function calcularExpiracao(plano) {
  const dias = DIAS_PLANO[plano] || 30;
  const exp = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  return exp;
}

// ── RESOLVER TEXTO ───────────────────────────────────────────
function resolver(texto, lead) {
  if (!texto) return "";
  const exp = lead.dataExpiracao ? new Date(lead.dataExpiracao).toLocaleDateString("pt-BR") : "—";
  const planoLabel = { mensal: "Mensal", trimestral: "Trimestral", anual: "Anual" }[lead.plano] || lead.plano;
  return texto
    .replace(/{nome}/g, lead.nomeCompleto || lead.username || "você")
    .replace(/{plano}/g, planoLabel)
    .replace(/{expiracao}/g, exp);
}

// ── ENVIAR MENSAGEM ──────────────────────────────────────────
async function enviarMsg(bot, chatId, texto, mediaUrl, mediaTipo, lead) {
  const txt = lead ? resolver(texto, lead) : (texto || "");
  try {
    if (mediaUrl) {
      if (mediaTipo === "foto")       await bot.sendPhoto(chatId, mediaUrl, { caption: txt, parse_mode: "HTML" });
      else if (mediaTipo === "video") await bot.sendVideo(chatId, mediaUrl, { caption: txt, parse_mode: "HTML" });
      else if (mediaTipo === "audio") await bot.sendAudio(chatId, mediaUrl);
      else                             await bot.sendMessage(chatId, txt, { parse_mode: "HTML" });
    } else if (txt) {
      await bot.sendMessage(chatId, txt, { parse_mode: "HTML" });
    }
  } catch (err) {
    log("ENVIO", `Erro chatId ${chatId}: ${err.message}`);
  }
}

// ── FUNIL INICIAL ────────────────────────────────────────────
async function processarFunil(bot, msg, lead, botConfig) {
  const funil = await prisma.funilAcesso.findUnique({
    where: { botId: botConfig.id },
    include: { passos: { orderBy: { ordem: "asc" } } },
  });
  if (!funil || !funil.passos.length) return false;

  const passo = funil.passos.find(p => p.ordem === lead.passoFunil);
  if (!passo) return false;

  if (passo.delay > 0) {
    await bot.sendChatAction(msg.chat.id, "typing");
    await new Promise(r => setTimeout(r, passo.delay * 1000));
  }

  await enviarMsg(bot, msg.chat.id, passo.texto, passo.mediaUrl, passo.mediaTipo, lead);

  const prox = lead.passoFunil + 1;
  const temProx = funil.passos.some(p => p.ordem === prox);
  await prisma.lead.update({
    where: { id: lead.id },
    data: { passoFunil: temProx ? prox : lead.passoFunil },
  });

  await prisma.mensagemEnviada.create({ data: { leadId: lead.id, tipo: "funil" } });
  return true;
}

// ── GERAR LINK DE ACESSO ÚNICO ───────────────────────────────
async function gerarLinkUnico(bot, grupoId) {
  try {
    const link = await bot.createChatInviteLink(grupoId, {
      member_limit: 1,
      name: `acesso_${Date.now()}`,
    });
    return link.invite_link;
  } catch (err) {
    log("LINK", `Erro ao gerar link: ${err.message}`);
    return null;
  }
}

// ── CONCEDER ACESSO (bot pago) ───────────────────────────────
async function concederAcesso(botId, leadId) {
  const inst = instancias.get(botId);
  if (!inst) return { ok: false, erro: "Bot offline" };

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  const botConfig = await prisma.botAcesso.findUnique({ where: { id: botId } });
  if (!lead || !botConfig) return { ok: false, erro: "Lead ou bot nao encontrado" };

  const link = await gerarLinkUnico(inst.bot, botConfig.grupoId);
  if (!link) return { ok: false, erro: "Nao foi possivel gerar link" };

  const dataExpiracao = calcularExpiracao(lead.plano);
  const dataAcesso = new Date();

  await prisma.lead.update({
    where: { id: leadId },
    data: { acessoConcedido: true, linkAcesso: link, dataAcesso, dataExpiracao, status: "ativo" },
  });

  const leadAtualizado = await prisma.lead.findUnique({ where: { id: leadId } });

  // Busca mensagem de acesso configurada
  const msgAcesso = await prisma.mensagemAgendada.findFirst({
    where: { botId, nome: "acesso", ativa: true },
    orderBy: { ordem: "asc" },
  });

  const textoAcesso = msgAcesso?.texto
    ? resolver(msgAcesso.texto, leadAtualizado).replace(/{link}/g, link)
    : `Seu acesso foi liberado! Clique no link para entrar: ${link}\n\nPlano: ${lead.plano}\nExpira em: ${dataExpiracao.toLocaleDateString("pt-BR")}`;

  await enviarMsg(inst.bot, parseInt(lead.telegramId), textoAcesso, msgAcesso?.mediaUrl, msgAcesso?.mediaTipo, leadAtualizado);
  await prisma.mensagemEnviada.create({ data: { leadId, tipo: "acesso" } });

  log(inst.nome, `Acesso concedido para lead ${leadId} — plano ${lead.plano}`);
  agendarMensagensLead(botId, leadId);
  return { ok: true, link };
}

// ── ACESSO TEMPORÁRIO (bot free) ─────────────────────────────
async function concederAcessoTemporario(botId, leadId, minutos) {
  const inst = instancias.get(botId);
  if (!inst) return { ok: false, erro: "Bot offline" };

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  const botConfig = await prisma.botAcesso.findUnique({ where: { id: botId } });
  if (!lead || !botConfig) return { ok: false, erro: "Nao encontrado" };

  const link = await gerarLinkUnico(inst.bot, botConfig.grupoId);
  if (!link) return { ok: false, erro: "Nao foi possivel gerar link" };

  try {
    await enviarMsg(inst.bot, parseInt(lead.telegramId),
      `Aqui esta seu acesso de ${minutos} minutos para conhecer o grupo:\n\n${link}\n\n<b>Atencao:</b> o link expira em ${minutos} minutos!`,
      null, null, lead);
  } catch (_) {}

  // Remove após X minutos
  setTimeout(async () => {
    try {
      await inst.bot.banChatMember(botConfig.grupoId, parseInt(lead.telegramId));
      await inst.bot.unbanChatMember(botConfig.grupoId, parseInt(lead.telegramId)); // unban pra nao ficar bloqueado
      await enviarMsg(inst.bot, parseInt(lead.telegramId),
        "Seu acesso de demonstracao expirou.\n\nGostou do que viu? Garanta seu acesso completo agora!",
        null, null, lead);
      log(inst.nome, `Acesso temporario removido — lead ${leadId}`);
    } catch (err) {
      log(inst.nome, `Erro ao remover acesso temp: ${err.message}`);
    }
  }, minutos * 60 * 1000);

  return { ok: true, link };
}

// ── REMOVER DO GRUPO ─────────────────────────────────────────
async function removerDoGrupo(botId, leadId, enviarAviso) {
  const inst = instancias.get(botId);
  if (!inst) return false;

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  const botConfig = await prisma.botAcesso.findUnique({ where: { id: botId } });
  if (!lead || !botConfig) return false;

  if (enviarAviso) {
    const msgRemocao = await prisma.mensagemAgendada.findFirst({
      where: { botId, nome: "remocao", ativa: true },
      orderBy: { ordem: "asc" },
    });
    const texto = msgRemocao?.texto ||
      "Seu acesso expirou e voce foi removido do grupo.\n\nPara renovar seu acesso clique abaixo e volte a fazer parte!";
    await enviarMsg(inst.bot, parseInt(lead.telegramId), texto, msgRemocao?.mediaUrl, msgRemocao?.mediaTipo, lead);
    await prisma.mensagemEnviada.create({ data: { leadId, tipo: "remocao" } });
  }

  try {
    await inst.bot.banChatMember(botConfig.grupoId, parseInt(lead.telegramId));
    await inst.bot.unbanChatMember(botConfig.grupoId, parseInt(lead.telegramId));
  } catch (err) {
    log(inst.nome, `Erro ao remover: ${err.message}`);
  }

  await prisma.lead.update({ where: { id: leadId }, data: { status: "removido" } });
  log(inst.nome, `Lead ${leadId} removido do grupo`);
  return true;
}

// ── AGENDAR MENSAGENS DO LEAD ────────────────────────────────
const timersLead = new Map(); // leadId -> [timers]

async function agendarMensagensLead(botId, leadId) {
  // Cancela timers anteriores do lead
  if (timersLead.has(leadId)) {
    timersLead.get(leadId).forEach(t => clearTimeout(t));
  }

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead || !lead.dataAcesso) return;

  const msgs = await prisma.mensagemAgendada.findMany({
    where: { botId, ativa: true, nome: { not: "acesso" }, nome: { not: "remocao" } },
    orderBy: { diaEnvio: "asc" },
  });

  const inst = instancias.get(botId);
  if (!inst) return;

  const timers = [];
  const dataAcesso = new Date(lead.dataAcesso);

  for (const msg of msgs) {
    // Calcula quando esta mensagem deve ser enviada
    const [hh, mm] = (msg.horario || "10:00").split(":").map(Number);
    const alvo = new Date(dataAcesso.getTime() + msg.diaEnvio * 24 * 60 * 60 * 1000);
    alvo.setUTCHours(hh + 3, mm, 0, 0); // horario Brasilia -> UTC

    const msAte = alvo.getTime() - Date.now();
    if (msAte <= 0) continue; // já passou

    const t = setTimeout(async () => {
      const leadAtual = await prisma.lead.findUnique({ where: { id: leadId } });
      if (!leadAtual || leadAtual.status === "removido") return;

      // Verifica se e mensagem de remocao
      if (msg.nome === "rmkt_remocao") {
        await removerDoGrupo(botId, leadId, true);
        return;
      }

      // Envia mensagem agendada
      await enviarMsg(inst.bot, parseInt(leadAtual.telegramId),
        resolver(msg.texto || "", leadAtual),
        msg.mediaUrl, msg.mediaTipo, leadAtual);

      await prisma.mensagemEnviada.create({
        data: { leadId, mensagemAgendadaId: msg.id, tipo: "agendada" },
      });
      log(inst.nome, `Mensagem agendada "${msg.nome}" enviada para lead ${leadId}`);
    }, msAte);

    timers.push(t);
    log(inst.nome, `Lead ${leadId}: "${msg.nome}" agendado para ${alvo.toISOString()} (${Math.round(msAte/3600000)}h)`);
  }

  timersLead.set(leadId, timers);
}

// ── RECARREGAR TIMERS (ao reiniciar) ────────────────────────
async function recarregarTimers() {
  const leads = await prisma.lead.findMany({
    where: { acessoConcedido: true, status: "ativo" },
  });
  for (const lead of leads) {
    await agendarMensagensLead(lead.botId, lead.id);
  }
  log("SISTEMA", `${leads.length} leads com timers recarregados`);
}

// ── RENOVAR ACESSO ───────────────────────────────────────────
async function renovarAcesso(leadId, plano) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return false;

  const novoPlano = plano || lead.plano;
  const novaExpiracao = calcularExpiracao(novoPlano);
  const agora2 = new Date();

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      plano: novoPlano,
      status: "ativo",
      dataAcesso: agora2,
      dataExpiracao: novaExpiracao,
      renovadoEm: agora2,
    },
  });

  // Se foi removido, gera novo link
  const inst = instancias.get(lead.botId);
  if (lead.status === "removido" && inst) {
    const botConfig = await prisma.botAcesso.findUnique({ where: { id: lead.botId } });
    const novoLink = await gerarLinkUnico(inst.bot, botConfig.grupoId);
    if (novoLink) {
      await prisma.lead.update({ where: { id: leadId }, data: { linkAcesso: novoLink } });
      const leadAtual = await prisma.lead.findUnique({ where: { id: leadId } });
      await enviarMsg(inst.bot, parseInt(lead.telegramId),
        `Seu acesso foi renovado! Novo link de acesso:\n\n${novoLink}\n\nPlano: ${novoPlano}\nExpira: ${novaExpiracao.toLocaleDateString("pt-BR")}`,
        null, null, leadAtual);
    }
  }

  agendarMensagensLead(lead.botId, leadId);
  log("SISTEMA", `Lead ${leadId} renovado — plano ${novoPlano}`);
  return true;
}

// ── INICIAR BOT ───────────────────────────────────────────────
async function iniciarBot(config) {
  if (instancias.has(config.id)) await pararBot(config.id);

  try {
    const bot = new TelegramBot(config.token, { polling: true });
    instancias.set(config.id, { bot, nome: config.nome, tipo: config.tipo, botId: config.id });
    log(config.nome, `Iniciado (${config.tipo})`);

    bot.on("message", async (msg) => {
      if (msg.chat.type !== "private") return;
      const telegramId = String(msg.chat.id);
      const texto = msg.text || "";

      // Detecta plano pelo deep link (/start p1m, p3m, p12m)
      let plano = "mensal";
      if (texto.startsWith("/start")) {
        const param = texto.split(" ")[1] || "";
        if (param.startsWith("p3m")) plano = "trimestral";
        else if (param.startsWith("p12m")) plano = "anual";
        else if (param.startsWith("p1m")) plano = "mensal";
      }

      // Busca ou cria lead
      let lead = await prisma.lead.findUnique({
        where: { botId_telegramId: { botId: config.id, telegramId } },
      });

      if (!lead) {
        const nomeCompleto = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
        lead = await prisma.lead.create({
          data: {
            botId: config.id,
            telegramId,
            username: msg.from?.username || null,
            nomeCompleto: nomeCompleto || null,
            plano,
            status: "pendente",
          },
        });
        log(config.nome, `Novo lead: ${nomeCompleto || telegramId} — plano ${plano}`);
      }

      // Processa funil
      await processarFunil(bot, msg, lead, config);
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
  log("SISTEMA", `${bots.length} bots iniciados`);
}

function getStatus() {
  const s = {};
  for (const [id, inst] of instancias.entries()) s[id] = { online: true, nome: inst.nome };
  return s;
}

module.exports = {
  iniciarBot, pararBot, iniciarTodosBots, getStatus,
  concederAcesso, concederAcessoTemporario, removerDoGrupo,
  renovarAcesso, agendarMensagensLead,
};
