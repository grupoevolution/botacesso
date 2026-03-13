require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const {
  iniciarTodosBots, iniciarBot, pararBot, getStatus,
  concederAcesso, concederAcessoTemporario, removerDoGrupo,
  renovarAcesso,
} = require("./botManager");

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));
app.use(session({
  secret: process.env.SESSION_SECRET || "segredo-acesso",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
}));

// ── SEED ─────────────────────────────────────────────────────
async function seed() {
  const existe = await prisma.admin.count();
  if (existe === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_SENHA || "admin123", 10);
    await prisma.admin.create({ data: { user: process.env.ADMIN_USER || "admin", senha: hash } });
    console.log("[SETUP] Admin criado");
  }

  // Config padrao de acesso temporario
  await prisma.config.upsert({
    where: { chave: "acesso_temp_minutos" },
    update: {},
    create: { chave: "acesso_temp_minutos", valor: "5" },
  });
}

function auth(req, res, next) {
  if (req.session.logado) return next();
  res.status(401).json({ erro: "Nao autenticado" });
}

// ── AUTH ──────────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  const { user, senha } = req.body;
  const admin = await prisma.admin.findUnique({ where: { user } });
  if (!admin) return res.status(401).json({ erro: "Usuario nao encontrado" });
  const ok = await bcrypt.compare(senha, admin.senha);
  if (!ok) return res.status(401).json({ erro: "Senha incorreta" });
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
    const id = parseInt(req.params.id);
    const { nome, token, grupoId, ativo } = req.body;
    const bot = await prisma.botAcesso.update({
      where: { id },
      data: { nome, token, grupoId, ativo: ativo !== false },
    });
    if (bot.ativo) await iniciarBot(bot); else await pararBot(id);
    res.json(bot);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.post("/api/bots/:id/toggle", auth, async (req, res) => {
  const id = parseInt(req.params.id);
  const bot = await prisma.botAcesso.findUnique({ where: { id } });
  const novoAtivo = !bot.ativo;
  await prisma.botAcesso.update({ where: { id }, data: { ativo: novoAtivo } });
  if (novoAtivo) await iniciarBot({ ...bot, ativo: true }); else await pararBot(id);
  res.json({ ativo: novoAtivo });
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
    const { passos } = req.body;
    await prisma.passoAcesso.deleteMany({ where: { funil: { botId } } }).catch(() => {});
    await prisma.funilAcesso.deleteMany({ where: { botId } }).catch(() => {});
    const funil = await prisma.funilAcesso.create({
      data: {
        botId,
        passos: {
          create: (passos || []).map((p, i) => ({
            ordem: i,
            texto: p.texto || null,
            mediaUrl: p.mediaUrl || null,
            mediaTipo: p.mediaTipo || null,
            delay: parseInt(p.delay) || 2,
          })),
        },
      },
      include: { passos: { orderBy: { ordem: "asc" } } },
    });
    res.json(funil);
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
    const { nome, diaEnvio, horario, texto, mediaUrl, mediaTipo } = req.body;
    const msg = await prisma.mensagemAgendada.create({
      data: {
        botId: parseInt(req.params.id),
        nome, horario: horario || "10:00",
        diaEnvio: parseInt(diaEnvio),
        texto: texto || null,
        mediaUrl: mediaUrl || null,
        mediaTipo: mediaTipo || null,
      },
    });
    res.json(msg);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.put("/api/mensagens/:id", auth, async (req, res) => {
  try {
    const { nome, diaEnvio, horario, texto, mediaUrl, mediaTipo, ativa } = req.body;
    res.json(await prisma.mensagemAgendada.update({
      where: { id: parseInt(req.params.id) },
      data: { nome, diaEnvio: parseInt(diaEnvio), horario, texto, mediaUrl, mediaTipo, ativa: ativa !== false },
    }));
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete("/api/mensagens/:id", auth, async (req, res) => {
  await prisma.mensagemAgendada.delete({ where: { id: parseInt(req.params.id) } });
  res.json({ ok: true });
});

// ── LEADS ─────────────────────────────────────────────────────
app.get("/api/leads", auth, async (req, res) => {
  const { botId, status, plano, busca } = req.query;
  const where = {};
  if (botId) where.botId = parseInt(botId);
  if (status) where.status = status;
  if (plano) where.plano = plano;
  if (busca) where.OR = [
    { nomeCompleto: { contains: busca } },
    { username: { contains: busca } },
    { telegramId: { contains: busca } },
  ];
  const leads = await prisma.lead.findMany({
    where,
    include: { bot: { select: { nome: true, tipo: true } }, _count: { select: { mensagensEnviadas: true } } },
    orderBy: { criadoEm: "desc" },
  });
  res.json(leads);
});

app.get("/api/leads/:id", auth, async (req, res) => {
  const lead = await prisma.lead.findUnique({
    where: { id: parseInt(req.params.id) },
    include: {
      bot: { select: { nome: true, tipo: true } },
      mensagensEnviadas: { orderBy: { enviadoEm: "desc" }, take: 20 },
    },
  });
  if (!lead) return res.status(404).json({ erro: "Nao encontrado" });
  res.json(lead);
});

// Ações manuais no lead
app.post("/api/leads/:id/conceder-acesso", auth, async (req, res) => {
  const lead = await prisma.lead.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!lead) return res.status(404).json({ erro: "Nao encontrado" });
  const r = await concederAcesso(lead.botId, lead.id);
  res.json(r);
});

app.post("/api/leads/:id/acesso-temporario", auth, async (req, res) => {
  const lead = await prisma.lead.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!lead) return res.status(404).json({ erro: "Nao encontrado" });
  const cfg = await prisma.config.findUnique({ where: { chave: "acesso_temp_minutos" } });
  const minutos = parseInt(cfg?.valor || "5");
  const r = await concederAcessoTemporario(lead.botId, lead.id, minutos);
  res.json(r);
});

app.post("/api/leads/:id/renovar", auth, async (req, res) => {
  const { plano } = req.body;
  const ok = await renovarAcesso(parseInt(req.params.id), plano);
  res.json({ ok });
});

app.post("/api/leads/:id/remover", auth, async (req, res) => {
  const lead = await prisma.lead.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!lead) return res.status(404).json({ erro: "Nao encontrado" });
  const ok = await removerDoGrupo(lead.botId, lead.id, true);
  res.json({ ok });
});

app.put("/api/leads/:id/plano", auth, async (req, res) => {
  const { plano } = req.body;
  await prisma.lead.update({ where: { id: parseInt(req.params.id) }, data: { plano } });
  res.json({ ok: true });
});

// ── WEBHOOK PERFECTPAY ────────────────────────────────────────
app.post("/webhook/perfectpay", async (req, res) => {
  const payload = JSON.stringify(req.body);
  try {
    const data = req.body;
    // PerfectPay envia: sale_status, customer_email, customer_phone, utm_source, utm_content, product_id
    // Usamos utm_content ou customer_phone para identificar o lead
    const status = data.sale_status || data.status || "";
    const isPago = ["approved", "paid", "completed", "active"].includes(status.toLowerCase());

    if (!isPago) {
      await prisma.webhookLog.create({ data: { payload, status: "ignorado" } });
      return res.json({ ok: true });
    }

    // Tenta encontrar o lead pelo telegramId na UTM ou pelo telefone
    const utmContent = data.utm_content || data.metadata?.telegram_id || "";
    const telegramId = utmContent.replace(/\D/g, "");

    let lead = null;
    if (telegramId) {
      lead = await prisma.lead.findFirst({ where: { telegramId } });
    }

    if (!lead) {
      await prisma.webhookLog.create({ data: { payload, status: "ignorado" } });
      return res.json({ ok: true, msg: "Lead nao identificado" });
    }

    // Detecta plano pelo produto ou UTM
    let plano = lead.plano;
    const utmSource = data.utm_source || "";
    if (utmSource.includes("3m") || utmSource.includes("trimestral")) plano = "trimestral";
    else if (utmSource.includes("12m") || utmSource.includes("anual")) plano = "anual";
    else if (utmSource.includes("1m") || utmSource.includes("mensal")) plano = "mensal";

    await renovarAcesso(lead.id, plano);
    await prisma.webhookLog.create({ data: { payload, status: "processado" } });
    console.log(`[WEBHOOK] Lead ${lead.id} renovado via PerfectPay — plano ${plano}`);
    res.json({ ok: true });
  } catch (err) {
    await prisma.webhookLog.create({ data: { payload, status: "erro: " + err.message } });
    res.status(500).json({ erro: err.message });
  }
});

// ── CONFIG ────────────────────────────────────────────────────
app.get("/api/config", auth, async (req, res) => {
  const configs = await prisma.config.findMany();
  const obj = {};
  configs.forEach(c => obj[c.chave] = c.valor);
  res.json(obj);
});

app.put("/api/config", auth, async (req, res) => {
  for (const [chave, valor] of Object.entries(req.body)) {
    await prisma.config.upsert({
      where: { chave },
      update: { valor: String(valor) },
      create: { chave, valor: String(valor) },
    });
  }
  res.json({ ok: true });
});

// ── DASHBOARD ─────────────────────────────────────────────────
app.get("/api/dashboard", auth, async (req, res) => {
  const [totalLeads, ativos, expirados, removidos, totalBots, webhooks] = await Promise.all([
    prisma.lead.count(),
    prisma.lead.count({ where: { status: "ativo" } }),
    prisma.lead.count({ where: { status: "expirado" } }),
    prisma.lead.count({ where: { status: "removido" } }),
    prisma.botAcesso.count(),
    prisma.webhookLog.count({ where: { status: "processado" } }),
  ]);

  // Leads expirando em breve (proximos 5 dias)
  const em5dias = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  const expirando = await prisma.lead.count({
    where: { status: "ativo", dataExpiracao: { lte: em5dias } },
  });

  const status = getStatus();
  res.json({ totalLeads, ativos, expirados, removidos, totalBots, webhooks, expirando, botsOnline: Object.keys(status).length });
});

// ── WEBHOOK LOGS ──────────────────────────────────────────────
app.get("/api/webhook-logs", auth, async (req, res) => {
  res.json(await prisma.webhookLog.findMany({ orderBy: { criadoEm: "desc" }, take: 50 }));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[SERVIDOR] Porta ${PORT}`);
  await seed();
  await iniciarTodosBots();
});
