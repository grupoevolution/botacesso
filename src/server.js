require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path    = require("path");
const bcrypt  = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const {
  iniciarTodosBots, iniciarBot, pararBot, getStatus,
  concederAcesso, concederAcessoTemporario, removerDoGrupo,
  renovarAcesso, gerarLinkManual,
} = require("./botManager");

const app    = express();
const prisma = new PrismaClient();

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));
app.use(session({
  secret: process.env.SESSION_SECRET || "acesso-secret-123",
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 86400000 },
}));

// ── SEED ─────────────────────────────────────────────────────
async function seed() {
  if (!await prisma.admin.count()) {
    await prisma.admin.create({
      data: {
        user:  process.env.ADMIN_USER  || "admin",
        senha: await bcrypt.hash(process.env.ADMIN_SENHA || "admin123", 10),
      },
    });
    console.log("[SETUP] Admin criado");
  }
  await prisma.config.upsert({
    where: { chave: "acesso_temp_minutos" },
    update: {}, create: { chave: "acesso_temp_minutos", valor: "5" },
  });
}

function auth(req, res, next) {
  if (req.session.logado) return next();
  res.status(401).json({ erro: "Não autenticado" });
}

// ── AUTH ──────────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  const { user, senha } = req.body;
  const admin = await prisma.admin.findUnique({ where: { user } });
  if (!admin || !await bcrypt.compare(senha, admin.senha))
    return res.status(401).json({ erro: "Credenciais inválidas" });
  req.session.logado = true;
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get("/api/me", (req, res) => res.json({ logado: !!req.session.logado }));

// ── BOTS ──────────────────────────────────────────────────────
app.get("/api/bots", auth, async (req, res) => {
  const bots = await prisma.botAcesso.findMany({
    include: { _count: { select: { leads: true } } },
    orderBy: { criadoEm: "asc" },
  });
  const status = getStatus();
  res.json(bots.map(b => ({ ...b, online: !!status[b.id] })));
});

app.post("/api/bots", auth, async (req, res) => {
  try {
    const { tipo, nome, token, grupoId } = req.body;
    const bot = await prisma.botAcesso.create({ data: { tipo, nome, token, grupoId } });
    await iniciarBot(bot);
    res.json(bot);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.put("/api/bots/:id", auth, async (req, res) => {
  try {
    const id  = parseInt(req.params.id);
    const bot = await prisma.botAcesso.update({
      where: { id },
      data: { nome: req.body.nome, token: req.body.token, grupoId: req.body.grupoId },
    });
    await iniciarBot(bot);
    res.json(bot);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.post("/api/bots/:id/toggle", auth, async (req, res) => {
  const id  = parseInt(req.params.id);
  const bot = await prisma.botAcesso.findUnique({ where: { id } });
  const novo = !bot.ativo;
  await prisma.botAcesso.update({ where: { id }, data: { ativo: novo } });
  if (novo) await iniciarBot({ ...bot, ativo: true }); else await pararBot(id);
  res.json({ ativo: novo });
});

app.get("/api/status", auth, (req, res) => res.json(getStatus()));

// ── FUNIL ─────────────────────────────────────────────────────
app.get("/api/bots/:id/funil", auth, async (req, res) => {
  const funil = await prisma.funilAcesso.findUnique({
    where: { botId: parseInt(req.params.id) },
    include: { passos: { orderBy: { ordem: "asc" } } },
  });
  res.json(funil || { passos: [] });
});

app.post("/api/bots/:id/funil", auth, async (req, res) => {
  try {
    const botId = parseInt(req.params.id);
    const existente = await prisma.funilAcesso.findUnique({ where: { botId } });
    if (existente) {
      await prisma.passoAcesso.deleteMany({ where: { funilId: existente.id } });
      await prisma.funilAcesso.delete({ where: { botId } });
    }
    const funil = await prisma.funilAcesso.create({
      data: {
        botId,
        passos: {
          create: (req.body.passos || []).map((p, i) => ({
            ordem: i, texto: p.texto || null, mediaUrl: p.mediaUrl || null,
            mediaTipo: p.mediaTipo || null,
            botoes: p.botoes ? JSON.stringify(p.botoes) : null,
            delay: parseInt(p.delay) ?? 2,
            gatilho: p.gatilho || "qualquer",
          })),
        },
      },
      include: { passos: { orderBy: { ordem: "asc" } } },
    });
    res.json(funil);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.post("/api/bots/:id/funil/importar", auth, async (req, res) => {
  try {
    const botId  = parseInt(req.params.id);
    const passos = req.body.passos;
    if (!Array.isArray(passos)) return res.status(400).json({ erro: "Esperado: { passos: [...] }" });

    const existente = await prisma.funilAcesso.findUnique({ where: { botId } });
    if (existente) {
      await prisma.passoAcesso.deleteMany({ where: { funilId: existente.id } });
      await prisma.funilAcesso.delete({ where: { botId } });
    }
    const funil = await prisma.funilAcesso.create({
      data: {
        botId,
        passos: {
          create: passos.map((p, i) => ({
            ordem: i, texto: p.texto || null, mediaUrl: p.mediaUrl || null,
            mediaTipo: p.mediaTipo || null,
            botoes: p.botoes ? JSON.stringify(p.botoes) : null,
            delay: parseInt(p.delay) ?? 2,
            gatilho: p.gatilho || "qualquer",
          })),
        },
      },
      include: { passos: { orderBy: { ordem: "asc" } } },
    });
    res.json({ ok: true, passos: funil.passos.length });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ── MENSAGENS AGENDADAS ───────────────────────────────────────
app.get("/api/bots/:id/mensagens", auth, async (req, res) => {
  res.json(await prisma.mensagemAgendada.findMany({
    where: { botId: parseInt(req.params.id) },
    orderBy: [{ diaEnvio: "asc" }, { ordem: "asc" }],
  }));
});

app.post("/api/bots/:id/mensagens", auth, async (req, res) => {
  try {
    const { nome, diaEnvio, horario, texto, mediaUrl, mediaTipo, botoes } = req.body;
    res.json(await prisma.mensagemAgendada.create({
      data: {
        botId: parseInt(req.params.id), nome,
        horario: horario || "10:00", diaEnvio: parseInt(diaEnvio),
        texto: texto || null, mediaUrl: mediaUrl || null, mediaTipo: mediaTipo || null,
        botoes: botoes ? JSON.stringify(botoes) : null,
      },
    }));
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.put("/api/mensagens/:id", auth, async (req, res) => {
  try {
    const { nome, diaEnvio, horario, texto, mediaUrl, mediaTipo, botoes, ativa } = req.body;
    res.json(await prisma.mensagemAgendada.update({
      where: { id: parseInt(req.params.id) },
      data: {
        nome, diaEnvio: parseInt(diaEnvio), horario, texto, mediaUrl, mediaTipo,
        botoes: botoes ? JSON.stringify(botoes) : null,
        ativa: ativa !== false,
      },
    }));
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete("/api/mensagens/:id", auth, async (req, res) => {
  await prisma.mensagemAgendada.delete({ where: { id: parseInt(req.params.id) } });
  res.json({ ok: true });
});

// ── LEADS ─────────────────────────────────────────────────────
app.get("/api/leads", auth, async (req, res) => {
  const { botId, status, busca } = req.query;
  const where = {};
  if (botId)  where.botId  = parseInt(botId);
  if (status) where.status = status;
  if (busca)  where.OR = [
    { nomeCompleto: { contains: busca } },
    { username:     { contains: busca } },
    { telegramId:   { contains: busca } },
  ];
  res.json(await prisma.lead.findMany({
    where,
    include: { bot: { select: { nome: true, tipo: true } }, _count: { select: { mensagensEnviadas: true } } },
    orderBy: { criadoEm: "desc" },
  }));
});

app.get("/api/leads/:id", auth, async (req, res) => {
  const lead = await prisma.lead.findUnique({
    where: { id: parseInt(req.params.id) },
    include: {
      bot: { select: { nome: true, tipo: true } },
      mensagensEnviadas: { orderBy: { enviadoEm: "desc" }, take: 30 },
    },
  });
  if (!lead) return res.status(404).json({ erro: "Não encontrado" });
  res.json(lead);
});

// Dar acesso (gera link + envia pelo bot)
app.post("/api/leads/:id/conceder-acesso", auth, async (req, res) => {
  const lead = await prisma.lead.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!lead) return res.status(404).json({ erro: "Não encontrado" });
  res.json(await concederAcesso(lead.botId, lead.id));
});

// Gerar link manualmente (sem enviar pro lead)
app.post("/api/leads/:id/gerar-link", auth, async (req, res) => {
  const lead = await prisma.lead.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!lead) return res.status(404).json({ erro: "Não encontrado" });
  const r = await gerarLinkManual(lead.botId);
  if (r.ok) {
    // Salva o link mas não registra o acesso nem envia nada
    await prisma.lead.update({ where: { id: lead.id }, data: { linkAcesso: r.link } });
  }
  res.json(r);
});

app.post("/api/leads/:id/acesso-temporario", auth, async (req, res) => {
  const lead = await prisma.lead.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!lead) return res.status(404).json({ erro: "Não encontrado" });
  const cfg = await prisma.config.findUnique({ where: { chave: "acesso_temp_minutos" } });
  res.json(await concederAcessoTemporario(lead.botId, lead.id, parseInt(cfg?.valor || "5")));
});

app.post("/api/leads/:id/renovar", auth, async (req, res) => {
  res.json({ ok: await renovarAcesso(parseInt(req.params.id), req.body.plano) });
});

app.post("/api/leads/:id/remover", auth, async (req, res) => {
  const lead = await prisma.lead.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!lead) return res.status(404).json({ erro: "Não encontrado" });
  res.json({ ok: await removerDoGrupo(lead.botId, lead.id, true) });
});

// ── WEBHOOK PERFECTPAY ────────────────────────────────────────
app.post("/webhook/perfectpay", async (req, res) => {
  const payload = JSON.stringify(req.body);
  try {
    const data    = req.body;
    const status  = (data.sale_status || data.status || "").toLowerCase();
    const isPago  = ["approved", "paid", "completed", "active"].includes(status);

    if (!isPago) {
      await prisma.webhookLog.create({ data: { payload, status: "ignorado" } });
      return res.json({ ok: true });
    }

    const telegramId = (data.utm_content || data.metadata?.telegram_id || "").replace(/\D/g, "");
    const lead = telegramId ? await prisma.lead.findFirst({ where: { telegramId } }) : null;

    if (!lead) {
      await prisma.webhookLog.create({ data: { payload, status: "ignorado-sem-lead" } });
      return res.json({ ok: true });
    }

    let plano = lead.plano;
    const src = (data.utm_source || "").toLowerCase();
    if (src.includes("3m") || src.includes("trimestral")) plano = "trimestral";
    else if (src.includes("12m") || src.includes("anual")) plano = "anual";
    else if (src.includes("1m") || src.includes("mensal")) plano = "mensal";

    await renovarAcesso(lead.id, plano);
    await prisma.webhookLog.create({ data: { payload, status: "processado" } });
    res.json({ ok: true });
  } catch (err) {
    await prisma.webhookLog.create({ data: { payload, status: "erro: " + err.message } });
    res.status(500).json({ erro: err.message });
  }
});

// ── CONFIG ────────────────────────────────────────────────────
app.get("/api/config", auth, async (req, res) => {
  const configs = await prisma.config.findMany();
  res.json(Object.fromEntries(configs.map(c => [c.chave, c.valor])));
});
app.put("/api/config", auth, async (req, res) => {
  for (const [chave, valor] of Object.entries(req.body)) {
    await prisma.config.upsert({
      where: { chave }, update: { valor: String(valor) }, create: { chave, valor: String(valor) },
    });
  }
  res.json({ ok: true });
});

// ── DASHBOARD ─────────────────────────────────────────────────
app.get("/api/dashboard", auth, async (req, res) => {
  const [total, ativos, removidos, pendentes, webhooks] = await Promise.all([
    prisma.lead.count(),
    prisma.lead.count({ where: { status: "ativo" } }),
    prisma.lead.count({ where: { status: "removido" } }),
    prisma.lead.count({ where: { status: "pendente" } }),
    prisma.webhookLog.count({ where: { status: "processado" } }),
  ]);
  const em5dias   = new Date(Date.now() + 5 * 86400000);
  const expirando = await prisma.lead.count({ where: { status: "ativo", dataExpiracao: { lte: em5dias } } });
  const leadsRecentes = await prisma.lead.findMany({
    include: { bot: { select: { nome: true } } },
    orderBy: { criadoEm: "desc" }, take: 10,
  });
  const ss = getStatus();
  res.json({ total, ativos, removidos, pendentes, webhooks, expirando, botsOnline: Object.keys(ss).length, leadsRecentes });
});

app.get("/api/webhook-logs", auth, async (req, res) => {
  res.json(await prisma.webhookLog.findMany({ orderBy: { criadoEm: "desc" }, take: 50 }));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[SERVER] Porta ${PORT}`);
  await seed();
  await iniciarTodosBots();
});
