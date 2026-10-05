import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const CompanySchema = new mongoose.Schema({ name: String, slug: { type: String, unique: true } });
const UserSchema = new mongoose.Schema({ name: String, email: { type: String, unique: true }, passwordHash: String, role: String, company_id: mongoose.Schema.Types.ObjectId });
const ProductSchema = new mongoose.Schema({ name: String, description: String, price: Number, currency: { type: String, default: 'BRL' }, category: String, objective: String, professional: String, duration: String, image: String, company_id: mongoose.Schema.Types.ObjectId });
const Company = mongoose.model('Company', CompanySchema);
const User = mongoose.model('User', UserSchema);
const Product = mongoose.model('Product', ProductSchema);

type Protocol = [name: string, description: string, category: string, professional: string, duration: string];
type Catalog = { name: string; email: string; adminName: string; memberName: string; protocols: Protocol[] };
const protocols: Protocol[] = [
  ['Avaliação Metabólica', 'Consulta inicial para entender histórico, objetivos e marcadores de saúde antes de qualquer protocolo.', 'Avaliação', 'Equipe Médica', '60 min'],
  ['Programa Emagrecimento', 'Acompanhamento médico e nutricional contínuo para uma estratégia individualizada.', 'Emagrecimento', 'Médico + Nutrição', '12 semanas'],
  ['Nutrição Clínica', 'Plano alimentar personalizado para composição corporal, energia e adesão sustentável.', 'Nutrição', 'Nutricionista', '8 semanas'],
  ['Saúde Hormonal Feminina', 'Acompanhamento para sintomas relacionados ao ciclo, menopausa e vitalidade.', 'Saúde feminina', 'Equipe Médica', '90 min'],
  ['Performance Integrada', 'Avaliação de rotina, recuperação e composição corporal para alta performance.', 'Performance', 'Equipe Médica', '6 semanas'],
  ['Soroterapia Vitalidade', 'Infusão realizada em ambiente clínico conforme indicação profissional.', 'Soroterapia', 'Enfermagem', '60 min'],
  ['Revisão de Exames', 'Consulta para organizar resultados laboratoriais e definir próximos passos.', 'Avaliação', 'Equipe Médica', '45 min'],
  ['Consulta de Longevidade', 'Plano de cuidado preventivo baseado em histórico, hábitos e objetivos.', 'Longevidade', 'Equipe Médica', '60 min'],
  ['Bioimpedância e Medidas', 'Acompanhamento de composição corporal para medir a evolução do cuidado.', 'Avaliação', 'Equipe Clínica', '30 min'],
  ['Acompanhamento Mensal', 'Retorno estruturado para revisar evolução e próximos marcos do protocolo.', 'Acompanhamento', 'Equipe Multidisciplinar', '30 min'],
  ['Consulta de Sono e Energia', 'Investigação clínica inicial para queixas de sono, cansaço e disposição.', 'Avaliação', 'Equipe Médica', '60 min']
];
const catalogs: Catalog[] = [
  { name: 'Clínica Aurora', email: 'admin@aurora.test', adminName: 'Marina Costa', memberName: 'Camila Oliveira', protocols },
  { name: 'Instituto Horizonte', email: 'admin@horizonte.test', adminName: 'André Lima', memberName: 'Rafael Martins', protocols: protocols.map(([name, description, category, professional, duration]) => [`${name} Horizonte`, description, category, professional, duration]) }
];

await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/atlas-catalog');
await Promise.all([Company.deleteMany({}), User.deleteMany({}), Product.deleteMany({})]);
for (const [companyIndex, catalog] of catalogs.entries()) {
  const company = await Company.create({ name: catalog.name, slug: catalog.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
  await User.create({ name: catalog.adminName, email: catalog.email, passwordHash: await bcrypt.hash('123456', 10), role: 'admin', company_id: company._id });
  await User.create({ name: catalog.memberName, email: `user${companyIndex + 1}@demo.test`, passwordHash: await bcrypt.hash('123456', 10), role: 'user', company_id: company._id });
  await Product.insertMany(catalog.protocols.map(([name, description, category, professional, duration], index) => ({ name, description, objective: `Cuidado personalizado em ${category.toLowerCase()}.`, professional, duration, price: 180 + index * 95 + companyIndex * 20, category, image: `https://images.unsplash.com/photo-${['1576091160399-112ba8d25d1d', '1559757175-0eb30cd8c063', '1571019613454-1cb2f99b2d8b'][index % 3]}?auto=format&fit=crop&w=800&q=80`, company_id: company._id })));
}
console.log('Seed complete. Admin: admin@aurora.test / 123456 | User: user1@demo.test / 123456');
await mongoose.disconnect();
