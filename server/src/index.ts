import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';
import type { Content, FunctionDeclaration, Part } from '@google/genai';

const app = express();
const gemini = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const allowedOrigins = (process.env.CLIENT_URL ?? 'http://localhost:5173').split(',').map(origin => origin.trim());
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

const UserSchema = new mongoose.Schema({ name: String, email: { type: String, unique: true }, passwordHash: String, role: { type: String, enum: ['admin', 'user'] }, company_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' } }, { timestamps: true });
const CompanySchema = new mongoose.Schema({ name: String, slug: { type: String, unique: true } });
const CURRENCIES = ['BRL', 'USD', 'EUR'] as const;
const ProductSchema = new mongoose.Schema({ name: String, description: String, price: Number, currency: { type: String, enum: CURRENCIES, default: 'BRL' }, category: String, objective: String, professional: String, duration: String, image: String, company_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true } }, { timestamps: true });
const Company = mongoose.model('Company', CompanySchema);
const User = mongoose.model('User', UserSchema);
const Product = mongoose.model('Product', ProductSchema);

type AuthRequest = express.Request & { user?: { id: string; company_id: string; role: 'admin' | 'user'; name: string; email: string } };
const signToken = (user: { _id: unknown; company_id?: unknown; role?: string | null; name?: string | null; email?: string | null }) => jwt.sign({ id: user._id, company_id: user.company_id, role: user.role, name: user.name, email: user.email }, process.env.JWT_SECRET ?? 'dev-secret', { expiresIn: '7d' });
const auth = (req: AuthRequest, res: express.Response, next: express.NextFunction) => { try { req.user = jwt.verify(req.headers.authorization?.replace('Bearer ', '') ?? '', process.env.JWT_SECRET ?? 'dev-secret') as AuthRequest['user']; next(); } catch { res.status(401).json({ message: 'Sessão inválida ou expirada.' }); } };
const adminOnly = (req: AuthRequest, res: express.Response, next: express.NextFunction) => req.user?.role === 'admin' ? next() : res.status(403).json({ message: 'Apenas administradores podem alterar produtos.' });

const productInput = z.object({ name: z.string().min(2), description: z.string().min(5), price: z.number().nonnegative(), currency: z.enum(CURRENCIES).default('BRL'), category: z.string().min(2), objective: z.string().min(2).optional(), professional: z.string().min(2).optional(), duration: z.string().min(2).optional(), image: z.string().url() });
const publicUser = (user: any) => ({ id: user._id, name: user.name, email: user.email, role: user.role, company_id: user.company_id });

app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/auth/register', async (req, res) => { try { const input = z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(6), companyName: z.string().min(2) }).parse(req.body); const company = await Company.create({ name: input.companyName, slug: `${input.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}` }); const user = await User.create({ name: input.name, email: input.email.toLowerCase(), passwordHash: await bcrypt.hash(input.password, 10), role: 'admin', company_id: company._id }); res.status(201).json({ token: signToken(user), user: publicUser(user), company }); } catch (error: any) { res.status(400).json({ message: error?.code === 11000 ? 'Este e-mail já está cadastrado.' : 'Não foi possível criar a conta.' }); } });
app.post('/auth/login', async (req, res) => { const input = z.object({ email: z.string().email(), password: z.string() }).safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Informe e-mail e senha.' }); const user = await User.findOne({ email: input.data.email.toLowerCase() }); if (!user || !(await bcrypt.compare(input.data.password, user.passwordHash ?? ''))) return res.status(401).json({ message: 'E-mail ou senha incorretos.' }); res.json({ token: signToken(user), user: publicUser(user), company: await Company.findById(user.company_id) }); });
app.get('/me', auth, async (req: AuthRequest, res) => { const user = await User.findById(req.user!.id); if (!user) return res.status(401).json({ message: 'Sessão inválida ou expirada.' }); res.json({ user: publicUser(user), company: await Company.findById(user.company_id) }); });
app.get('/products', auth, async (req: AuthRequest, res) => { const products = await Product.find({ company_id: req.user!.company_id }).sort({ createdAt: -1 }).lean(); res.json(products); });
app.post('/products', auth, adminOnly, async (req: AuthRequest, res) => { const parsed = productInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Revise os campos do produto.' }); res.status(201).json(await Product.create({ ...parsed.data, company_id: req.user!.company_id })); });
app.put('/products/:id', auth, adminOnly, async (req: AuthRequest, res) => { const parsed = productInput.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Revise os campos do produto.' }); const product = await Product.findOneAndUpdate({ _id: req.params.id, company_id: req.user!.company_id }, parsed.data, { new: true }); product ? res.json(product) : res.status(404).json({ message: 'Produto não encontrado.' }); });
app.delete('/products/:id', auth, adminOnly, async (req: AuthRequest, res) => { const result = await Product.deleteOne({ _id: req.params.id, company_id: req.user!.company_id }); result.deletedCount ? res.status(204).send() : res.status(404).json({ message: 'Produto não encontrado.' }); });

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function executeSearchProducts(args: { query?: string; category?: string; max_price?: number; sort?: 'price_asc' | 'relevance'; quantity?: number }, companyId: string) { const filter: any = { company_id: companyId }; if (args.category) filter.category = new RegExp(`^${escapeRegex(args.category)}$`, 'i'); if (args.max_price !== undefined) filter.price = { $lte: args.max_price }; if (args.query) { const terms = args.query.toLowerCase().split(/\s+/).filter(term => term.length > 3).map(escapeRegex); filter.$or = terms.flatMap(term => [{ name: { $regex: term, $options: 'i' } }, { description: { $regex: term, $options: 'i' } }, { category: { $regex: term, $options: 'i' } }, { objective: { $regex: term, $options: 'i' } }, { professional: { $regex: term, $options: 'i' } }]); } const sort: Record<string, 1 | -1> = args.sort === 'price_asc' ? { price: 1 } : { createdAt: -1 }; return (await Product.find(filter).sort(sort).limit(Math.min(Math.max(args.quantity ?? 10, 1), 10)).lean()).map(({ _id, name, description, price, currency, category, objective, professional, duration, image }) => ({ id: _id, name, description, price, currency, category, objective, professional, duration, image })); }

const searchProductsDeclaration: FunctionDeclaration = { name: 'search_products', description: 'Busca protocolos/produtos no catálogo da empresa do usuário autenticado. Use sempre que a pergunta envolver produtos, preços, categorias ou disponibilidade.', parametersJsonSchema: { type: 'object', properties: { query: { type: 'string', description: 'Termo de busca livre (nome, descrição, categoria ou objetivo)' }, category: { type: 'string', description: 'Categoria exata para filtrar' }, max_price: { type: 'number', description: 'Preço máximo, no valor numérico do item (compare apenas dentro da mesma moeda)' }, sort: { type: 'string', enum: ['price_asc', 'relevance'], description: 'Ordenar por menor preço ou relevância' }, quantity: { type: 'number', description: 'Quantidade máxima de resultados (1 a 10)' } } } };
const CHAT_SYSTEM_PROMPT = 'Você é o assistente de catálogo de uma empresa em uma plataforma SaaS multi-tenant. Responda em português, de forma breve e direta, usando exclusivamente os dados retornados pela ferramenta search_products. Cada item retornado tem um campo currency (BRL, USD ou EUR); sempre cite o preço com o símbolo correto dessa moeda (R$ para BRL, US$ para USD, € para EUR), nunca assuma BRL se o campo disser outra coisa. Nunca invente produtos, preços, categorias ou disponibilidade que não estejam no resultado da ferramenta. Se a busca não retornar nada relevante, diga isso claramente ao usuário. Nunca mencione company_id, IDs internos ou detalhes técnicos.';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function generateContentWithRetry(params: Parameters<NonNullable<typeof gemini>['models']['generateContent']>[0], attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await gemini!.models.generateContent(params);
    } catch (error: any) {
      const transient = error?.status === 503 || error?.status === 429 || /UNAVAILABLE|high demand|RESOURCE_EXHAUSTED/i.test(error?.message ?? '');
      if (!transient || attempt === attempts) throw error;
      await sleep(attempt * 2000);
    }
  }
  throw new Error('unreachable');
}

app.post('/chat', auth, async (req: AuthRequest, res) => {
  const parsedMessage = z.string().min(1).max(1000).safeParse(req.body.message);
  if (!parsedMessage.success) return res.status(400).json({ message: 'Envie uma pergunta válida.' });
  if (!gemini) return res.status(503).json({ message: 'Assistente de IA indisponível: configure GEMINI_API_KEY no servidor.' });

  const companyId = req.user!.company_id;
  const model = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';
  const config = { systemInstruction: CHAT_SYSTEM_PROMPT, tools: [{ functionDeclarations: [searchProductsDeclaration] }] };
  const contents: Content[] = [{ role: 'user', parts: [{ text: parsedMessage.data }] }];

  try {
    const first = await generateContentWithRetry({ model, contents, config });
    const calls = first.functionCalls;

    if (!calls?.length) return res.json({ reply: first.text ?? 'Não consegui gerar uma resposta.', source: 'llm' });

    const modelTurn = first.candidates?.[0]?.content;
    if (modelTurn) contents.push(modelTurn);

    const responseParts: Part[] = [];
    for (const call of calls) {
      const args = (call.name === 'search_products' ? call.args : {}) as { query?: string; category?: string; max_price?: number; sort?: 'price_asc' | 'relevance'; quantity?: number } | undefined;
      const results = await executeSearchProducts(args ?? {}, companyId);
      responseParts.push({ functionResponse: { id: call.id, name: call.name ?? 'search_products', response: { results } } });
    }
    contents.push({ role: 'user', parts: responseParts });

    const second = await generateContentWithRetry({ model, contents, config });
    res.json({ reply: second.text ?? 'Não consegui gerar uma resposta.', source: 'llm+tool' });
  } catch (error: any) {
    console.error('Chat error:', error.message);
    res.status(502).json({ message: 'Não foi possível consultar o assistente de IA no momento.' });
  }
});

const port = Number(process.env.PORT ?? 4000);
mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/atlas-catalog').then(() => app.listen(port, () => console.log(`API running at http://localhost:${port}`))).catch(error => { console.error('MongoDB connection failed:', error.message); process.exit(1); });
