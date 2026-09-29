// Seeds a throwaway demo database for local UI work. Never point this at production data:
//   DATA_DIR=./data-demo bun scripts/seed-demo.ts
import { config } from "../src/server/config";

if (!config.dataDir.includes("demo")) {
  console.error(`Refusing to seed ${config.dataDir}: DATA_DIR must contain "demo".`);
  process.exit(1);
}

const { db } = await import("../src/server/db");
const { periodOf } = await import("../src/server/time");
const { VALUES, REACTIONS } = await import("../src/shared/values");

const depts = [
  ["d-collect", "数据采集", "Data Collection"],
  ["d-algo", "算法", "Algorithms"],
  ["d-platform", "平台工程", "Platform"],
  ["d-design", "产品设计", "Product & Design"],
  ["d-ops", "运营", "Operations"],
  ["d-biz", "商务", "Business"],
] as const;

const people: [string, string, string, string, string][] = [
  ["mushan", "Mushan Yang", "Mushan Yang", "d-platform", "Engineering Lead"],
  ["lin.xiao", "林晓", "Xiao Lin", "d-collect", "现场采集负责人"],
  ["chen.yu", "陈宇", "Yu Chen", "d-algo", "SLAM 算法工程师"],
  ["wang.jing", "王静", "Jing Wang", "d-design", "产品设计师"],
  ["zhao.lei", "赵磊", "Lei Zhao", "d-platform", "后端工程师"],
  ["sun.mei", "孙美琪", "Meiqi Sun", "d-ops", "运营经理"],
  ["zhou.hang", "周航", "Hang Zhou", "d-collect", "采集工程师"],
  ["wu.di", "吴迪", "Di Wu", "d-algo", "数据科学家"],
  ["zheng.yan", "郑妍", "Yan Zheng", "d-biz", "客户成功"],
  ["he.tao", "何涛", "Tao He", "d-platform", "前端工程师"],
  ["luo.xin", "罗欣", "Xin Luo", "d-design", "UX 研究员"],
  ["gao.peng", "高鹏", "Peng Gao", "d-collect", "硬件工程师"],
  ["ma.lu", "马璐", "Lu Ma", "d-ops", "质检主管"],
  ["xu.ke", "徐珂", "Ke Xu", "d-algo", "机器学习工程师"],
  ["song.jia", "宋佳", "Jia Song", "d-biz", "商务拓展"],
  ["han.bo", "韩博", "Bo Han", "d-platform", "SRE"],
  ["feng.yi", "冯怡", "Yi Feng", "d-ops", "项目经理"],
  ["tang.rui", "唐睿", "Rui Tang", "d-algo", "感知算法工程师"],
  ["emily", "Emily Carter", "Emily Carter", "d-biz", "Account Executive"],
  ["daniel", "Daniel Kim", "Daniel Kim", "d-collect", "Field Ops Lead"],
  ["ye.qing", "叶青", "Qing Ye", "d-design", "视觉设计师"],
  ["cao.yang", "曹阳", "Yang Cao", "d-platform", "数据平台工程师"],
  ["deng.xue", "邓雪", "Xue Deng", "d-ops", "标注运营"],
  ["jiang.fan", "蒋帆", "Fan Jiang", "d-collect", "采集工程师"],
];

const messages = [
  "上周采集设备在现场出问题，你连夜远程帮我们排查到凌晨两点，第二天一早数据就恢复了。真的太靠谱了！",
  "新的标注工具界面改得太顺手了，效率至少提升了一倍，大家都在夸。",
  "谢谢你在客户 demo 前帮我把整套 pipeline 又跑了一遍，还发现了两个隐藏 bug，救大命了。",
  "Thanks for walking me through the SLAM calibration — your notes are now our team's bible.",
  "入职第一周就被你带着熟悉了所有流程，感觉一点都不陌生，谢谢你这么耐心！",
  "你写的数据质检脚本救了整个项目组，报告自动生成太香了。",
  "客户反馈这次交付是他们见过质量最高的一批数据，这背后是你一遍遍抽检的结果。",
  "Huge thanks for jumping in on the weekend to fix the upload pipeline. Absolute legend.",
  "昨天的技术分享讲得太好了，把一个很复杂的问题讲得清清楚楚，受益匪浅。",
  "谢谢你每天早上带来的咖啡和好心情 ☕",
  "你总是第一个站出来帮大家解决问题，团队有你真好。",
  "设计稿细节打磨到像素级，用户体验一下子上了一个台阶。",
  "感谢你帮我 review 了三轮 PR，每一条建议都很有启发，学到了好多。",
  "Thanks for keeping the whole team calm during the launch crunch. You made it feel doable.",
  "海外站点的协调工作太难了，你一个人扛下来了，respect！",
  "临时加的需求你二话不说就接了，还提前一天交付，太给力了。",
  "谢谢你把新同事的 onboarding 文档整理得这么清楚，省了大家好多时间。",
  "采集现场 40 度高温，你还坚持把每个场景都复核了一遍，辛苦了！",
];

const comments = ["+1，确实太强了！", "附议 👏", "这个必须夸", "学到了！", "So well deserved!", "respect 🙌", "感动哭了"];

const now = Date.now();
db.exec("DELETE FROM reactions; DELETE FROM comments; DELETE FROM post_recipients; DELETE FROM posts; DELETE FROM users; DELETE FROM departments; DELETE FROM sqlite_sequence;");
for (const [id, name, en] of depts) {
  db.query("INSERT INTO departments (id, name, en_name, updated_at) VALUES ($id, $name, $en, $now)").run({ id, name, en, now });
}
const ids: number[] = [];
people.forEach(([handle, name, en, dept, title], i) => {
  const res = db
    .query(
      `INSERT INTO users (open_id, email, name, en_name, dept_id, job_title, active, source, joined_at, created_at, updated_at)
       VALUES ($openId, $email, $name, $en, $dept, $title, 1, 'lark', $joined, $now, $now)`,
    )
    .run({
      openId: `ou_demo_${handle}`,
      email: `${handle}@maxinsights.ai`,
      name,
      en: en === name ? null : en,
      dept,
      title,
      joined: i >= people.length - 3 ? now - (10 + i) * 86400_000 : now - (200 + i * 9) * 86400_000,
      now,
    });
  ids.push(Number(res.lastInsertRowid));
});

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

const insertPost = db.query(
  `INSERT INTO posts (kind, sender_id, message, value_tag, points, cost, period, created_at)
   VALUES ($kind, $sender, $message, $tag, $points, $cost, $period, $at)`,
);
const insertRecipient = db.query("INSERT OR IGNORE INTO post_recipients (post_id, user_id) VALUES ($post, $user)");
const insertReaction = db.query("INSERT OR IGNORE INTO reactions (post_id, user_id, emoji, created_at) VALUES ($post, $user, $emoji, $at)");
const insertComment = db.query("INSERT INTO comments (post_id, user_id, body, created_at) VALUES ($post, $user, $body, $at)");

const times = Array.from({ length: 64 }, () => now - Math.floor(Math.pow(rand(), 1.6) * 75 * 86400_000) - 60_000).sort((a, b) => a - b);
for (const at of times) {
  const sender = pick(ids);
  const count = rand() < 0.2 ? 2 + Math.floor(rand() * 2) : 1;
  const recipients = new Set<number>();
  while (recipients.size < count) {
    const r = pick(ids);
    if (r !== sender) recipients.add(r);
  }
  const bonus = rand() < 0.28;
  const points = bonus ? pick([10, 20, 50]) : 0;
  const res = insertPost.run({
    kind: bonus ? "bonus" : "kudos",
    sender,
    message: pick(messages),
    tag: rand() < 0.85 ? pick(VALUES).id : null,
    points,
    cost: points * recipients.size,
    period: periodOf(at),
    at,
  });
  const post = Number(res.lastInsertRowid);
  for (const u of recipients) insertRecipient.run({ post, user: u });
  const nReactions = Math.floor(rand() * 7);
  for (let k = 0; k < nReactions; k++) insertReaction.run({ post, user: pick(ids), emoji: pick(REACTIONS.slice(0, 5)), at: at + 1000 });
  if (rand() < 0.3) insertComment.run({ post, user: pick(ids), body: pick(comments), at: at + 5000 });
}
console.log(`seeded ${ids.length} people and 64 posts into ${config.dataDir}`);
