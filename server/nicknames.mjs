// 内部 AI 账号的网名。默认本地组合，风格接近中文社交昵称。
// 只有显式配置 NOVA_NICK_API_KEY 时才请求模型，失败则退回本地，不会用机器编号充数。

const HEADS = ['晚风','月色','巷口','窗台','半糖','晴空','雾里','南风','小岛','星河','午后','橘灯','海边','旧信','云边','青柠','抹茶','苏打','未读','北窗','慢热','浅眠','梧桐','潮汐','纸飞机','小满','谷雨','白露','晴川','南烛','盐汽水','橘子海','放学后','便利店','二楼窗','旧耳机','月亮邮差','半熟','不赶路','刚睡醒'];
const TAILS = ['收信','放空','慢慢走','在听歌','不打烊','想躺平','刚好','而已','向南','七点半','会发光','不熬夜','邮递中','看海','发呆','躲雨','写一半','未命名','也好','就好','先这样','偷偷开心','不回消息','把灯关了','等风','吃冰','散步','晚点说','在呢','哦'];
const WHOLE = ['晚风收信','半糖不熬夜','云边小卖部','月亮邮递员','巷口的灯','未读的夏天','一只晚睡','北岛放空','柠檬苏打','今天也晴','窗台种风','盐汽水气泡','旧耳机循环','放学后见','二楼不营业','纸飞机晚点','梧桐影','潮汐信箱','浅眠日记','慢热选手','南风过境','雾里看灯','青柠半颗','抹茶四分糖','橘灯亮着','海边捡句子','星河打烊','午后三点','小岛来信','晴空很小','不赶末班','刚睡醒的猫','便利店关东煮','白露未至','谷雨前','小满不满','半熟主义','把夏天折好','路灯值班','云先走了','想把风关掉','信寄给自己','耳机分你一半','雨停再回','月亮下班了','甜度自己调','不回也没关系','巷子尽头转弯','窗没关严','风有回信','海很安静','今天先这样','晚点再闪亮','猫先睡了','茶凉得刚好','步子放慢','灯还亮着','南边有信','岛上没信号','汽水没气了','橘子分你','耳机单曲循环','放学路口','二楼的风','纸页潮了','梧桐落一地','潮水准时','浅浅的困','慢一点也好','北窗开着','雾还没散','青柠气泡','抹茶要热的','橘黄那盏','海边风大','星子很稀','午后不办事','小岛放假','晴到发白','不赶时间','醒了但没起','关东煮加热','白露之后','谷雨信','小满刚好','半熟就好','夏天折页','路灯换班','云在排队','风的草稿','信没有地址','耳机另一边','雨的间歇','月亮请假','甜度两分','不回复也行','巷口转弯','窗缝里的风'];

const LOW_NAME = /(?:^|[_\-\s])(?:ai|bot|robot|npc|user|test|guest|demo)(?:[_\-\s]|$)|^(?:ai|bot|robot|npc|user|test|guest|demo)[_-]?\d+$|^(?:用户|机器人|测试号?|内部号|账号|小号)\d*$|^[a-z]{1,8}[_-]?\d{2,}$|^\d+$/i;

export function looksLow(name) {
  const s = String(name || '').trim();
  if (!s) return true;
  return LOW_NAME.test(s);
}

export function localNicknames(count, rng = Math.random) {
  const n = Math.max(0, count | 0);
  const seen = new Set();
  const pool = [];
  const add = (raw) => {
    const name = String(raw || '').trim().slice(0, 12);
    if (name.length < 2 || seen.has(name) || looksLow(name)) return;
    seen.add(name);
    pool.push(name);
  };
  for (const w of WHOLE) add(w);
  for (const h of HEADS) for (const t of TAILS) add(h + t);
  for (const h of HEADS) add(h);
  if (!pool.length || !n) return [];
  const start = Math.floor(rng() * pool.length) % pool.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[(start + i) % pool.length]);
  return out;
}

function sanitizeModelNames(list) {
  const used = new Set();
  const out = [];
  for (const raw of list || []) {
    const name = String(raw || '').replace(/[\r\n\t]/g, '').trim().slice(0, 12);
    if (name.length < 2 || name.length > 12) continue;
    if (looksLow(name) || used.has(name)) continue;
    if (/https?:|@|[#/\\]/.test(name)) continue;
    used.add(name);
    out.push(name);
  }
  return out;
}

async function modelNicknames(count, {key, base, model, fetchImpl}) {
  const url = String(base || 'https://api.x.ai/v1').replace(/\/$/, '') + '/chat/completions';
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key},
    body: JSON.stringify({
      model: model || 'grok-4-fast',
      temperature: 0.9,
      messages: [
        {role: 'system', content: '你给中文社交产品起原创网名。只要看起来像真人会用的昵称：日常、轻轻诗意、口语。不要名人、品牌、政治、色情。不要「用户123」「AI_bot」「测试号」。每个 2 到 8 个字。只返回 JSON 字符串数组。'},
        {role: 'user', content: '生成 ' + count + ' 个互不重复的网名。'},
      ],
    }),
  });
  if (!res.ok) throw new Error('nick api ' + res.status);
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('nick api bad json');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('nick api not array');
  return sanitizeModelNames(parsed);
}

export async function generateNicknames(count, {env = process.env, rng = Math.random, fetchImpl = globalThis.fetch} = {}) {
  const n = Math.min(200, Math.max(1, count | 0));
  const key = String((env && env.NOVA_NICK_API_KEY) || '').trim();
  if (key) {
    try {
      const got = await modelNicknames(n, {
        key,
        base: env.NOVA_NICK_API_BASE || 'https://api.x.ai/v1',
        model: env.NOVA_NICK_MODEL || 'grok-4-fast',
        fetchImpl,
      });
      if (got.length >= n) return got.slice(0, n);
      const fill = localNicknames(n, rng).filter(x => !got.includes(x));
      return [...got, ...fill].slice(0, n);
    } catch {
      /* 模型不可用时仍给出网名，不回退成编号 */
    }
  }
  return localNicknames(n, rng);
}
