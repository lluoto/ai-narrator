// 摄取管线 · 章节切分
//
// 输入是清洗后的逐页文本，输出是可寻址的块。
// 锚点有两种，实样里都验证过：
//   短的冒号结尾行  → 场景/小节标题（"农场外围："）
//   ▶ 开头的行      → 条目（全书 45 条，四个陷阱全在内）
//
// 层级是要紧的：▶捕兽夹 属于 农场外围 这个场景，不是和它平级。
// 扁平化之后，陷阱就不知道该挂到哪个场景上了 —— 而这正是之前
// support.trapSceneId 那种单数硬编码的由来。

import { describe, test, expect } from "bun:test";
import { sectionize } from "../ingest/sectionize";

describe("标题切分", () => {
  test("一个标题带一段正文", () => {
    const s = sectionize(["农场外围：\n这里是非常危险的一个场景。"]);
    expect(s).toHaveLength(1);
    expect(s[0]?.title).toBe("农场外围");
    expect(s[0]?.body).toBe("这里是非常危险的一个场景。");
  });

  test("标题末尾的冒号被去掉 —— 冒号是分隔符不是名字的一部分", () => {
    expect(sectionize(["维修间：\n正文"])[0]?.title).toBe("维修间");
  });

  test("多个标题各自成块，正文不串", () => {
    const s = sectionize(["甲场景：\n甲的正文。\n乙场景：\n乙的正文。"]);
    expect(s.map((x) => x.title)).toEqual(["甲场景", "乙场景"]);
    expect(s[0]?.body).toBe("甲的正文。");
    expect(s[1]?.body).toBe("乙的正文。");
  });

  test("标题之间没有正文时 body 为空串，而不是丢块", () => {
    const s = sectionize(["甲：\n乙：\n乙的正文。"]);
    expect(s).toHaveLength(2);
    expect(s[0]?.body).toBe("");
  });

  test("多行正文全部归入所属标题", () => {
    const s = sectionize(["农场外围：\n第一行。\n第二行。\n第三行。"]);
    expect(s[0]?.body).toBe("第一行。\n第二行。\n第三行。");
  });
});

describe("▶ 条目", () => {
  test("条目归到所在标题名下，不是平级", () => {
    const s = sectionize(["农场外围：\n艾德里安会在外围布置 3 种陷阱：\n▶捕兽夹：体形小于 35 的角色会免疫\n▶音响陷阱：已经失去了作用"]);
    expect(s).toHaveLength(1);
    expect(s[0]?.items.map((i) => i.name)).toEqual(["捕兽夹", "音响陷阱"]);
  });

  test("条目名与正文以第一个冒号切开", () => {
    const s = sectionize(["场景：\n▶捕兽夹：体形小于 35 的角色会免疫这种陷阱"]);
    expect(s[0]?.items[0]?.name).toBe("捕兽夹");
    expect(s[0]?.items[0]?.text).toBe("体形小于 35 的角色会免疫这种陷阱");
  });

  test("条目正文里的冒号不影响切分", () => {
    const s = sectionize(["场景：\n▶老旧文件：记载着这样一句话：不可名状"]);
    expect(s[0]?.items[0]?.name).toBe("老旧文件");
    expect(s[0]?.items[0]?.text).toBe("记载着这样一句话：不可名状");
  });

  test("没有冒号的条目整行作为正文，名字留空", () => {
    // 实样里确实有这种：▶菲碧平时没有看报纸的习惯，她一直在等待警方的电话
    const s = sectionize(["场景：\n▶菲碧平时没有看报纸的习惯"]);
    expect(s[0]?.items[0]?.name).toBe("");
    expect(s[0]?.items[0]?.text).toBe("菲碧平时没有看报纸的习惯");
  });

  test("条目不混进 body", () => {
    const s = sectionize(["场景：\n正文一句。\n▶条目：条目正文"]);
    expect(s[0]?.body).toBe("正文一句。");
  });

  test("明确发现列表引导后的连续短标签条目进入 items，且保留页内坐标", () => {
    const s = sectionize([
      "调查地点：\n搜索房间后可以发现以下物品。\n样本甲：倒在床边。",
      "样本乙：嵌在墙上。\n样本丙：有奇怪的痕迹。\n列表结束后的叙述正文。\n旁注：这不是发现物。",
    ]);

    expect(s).toHaveLength(1);
    expect(s[0]?.items).toEqual([
      { name: "样本甲", text: "倒在床边。", source: { page: 1, line: 3 } },
      { name: "样本乙", text: "嵌在墙上。", source: { page: 2, line: 1 } },
      { name: "样本丙", text: "有奇怪的痕迹。", source: { page: 2, line: 2 } },
    ]);
    expect(s[0]?.body).toContain("列表结束后的叙述正文。");
  });

  test("没有发现列表引导时，NPC、技能、护甲与规则冒号字段仍是正文", () => {
    const s = sectionize([[
      "人物资料：",
      "力量：10",
      "技能：侦查 60%",
      "护甲：2",
      "规则说明：",
      "伤害：1d6",
      "染血钥匙：挂在门后。",
    ].join("\n")]);

    expect(s.flatMap((section) => section.items)).toEqual([]);
  });
});

describe("既像条目又像标题的行", () => {
  // 实样里有这么一类：`▶证物室：` 自成一行，冒号后面什么都没有，
  // 底下再挂着 `▶防斗门的钥匙：…` 这样的真条目。
  // 它在原文里就是个小节标题，基准模组里 `证物室` 也确实是一个场景。
  // 先按标题规则匹配会把 ▶ 一起吃进标题，场景名就成了 "▶证物室"，对不上。

  test("▶ 开头且冒号后无内容的短行是标题，▶ 要剥掉", () => {
    const s = sectionize(["▶证物室：\n进入证物室后可以看到"]);
    expect(s[0]?.title).toBe("证物室");
    expect(s[0]?.body).toBe("进入证物室后可以看到");
  });

  test("这类标题名下的真条目照常归属", () => {
    const s = sectionize(["▶证物室：\n正文。\n▶防盗门的钥匙：用来打开谷仓的门"]);
    expect(s).toHaveLength(1);
    expect(s[0]?.title).toBe("证物室");
    expect(s[0]?.items.map((i) => i.name)).toEqual(["防盗门的钥匙"]);
  });

  test("▶ 后冒号有内容的仍是条目，不是标题", () => {
    const s = sectionize(["场景：\n▶捕兽夹：体形小于 35 的角色会免疫"]);
    expect(s[0]?.title).toBe("场景");
    expect(s[0]?.items[0]?.name).toBe("捕兽夹");
  });

  test("▶ 后名字过长且冒号后无内容 —— 不当标题，仍作条目", () => {
    const s = sectionize(["场景：\n▶抽屉里的关于***号农场的转购协议："]);
    expect(s[0]?.title).toBe("场景");
    expect(s[0]?.items[0]?.name).toBe("抽屉里的关于***号农场的转购协议");
  });
});

describe("首个标题之前的内容", () => {
  test("落到一个标题为空的前置块里，不丢弃", () => {
    // 第 1 页开头是书名，前面没有任何标题
    const s = sectionize(["《普瑞米尔的谷仓》ver1.03\n前言：\n本模组是……"]);
    expect(s[0]?.title).toBe("");
    expect(s[0]?.body).toBe("《普瑞米尔的谷仓》ver1.03");
    expect(s[1]?.title).toBe("前言");
  });

  test("整页没有标题时只产出一个前置块", () => {
    const s = sectionize(["就是一段没有任何标题的正文。"]);
    expect(s).toHaveLength(1);
    expect(s[0]?.title).toBe("");
  });
});

describe("跨页", () => {
  test("一个标题的正文跨页时接续，不被页边界切断", () => {
    const s = sectionize(["农场外围：\n上半段。", "下半段。"]);
    expect(s).toHaveLength(1);
    expect(s[0]?.body).toBe("上半段。\n下半段。");
  });

  test("下一页出现新标题则正常起新块", () => {
    const s = sectionize(["甲：\n甲正文。", "乙：\n乙正文。"]);
    expect(s.map((x) => x.title)).toEqual(["甲", "乙"]);
  });
});

describe("溯源", () => {
  test("标题记录页码与页内行号 —— Provenance 的 sourceRef 要用", () => {
    const s = sectionize(["第一页正文。", "农场外围：\n正文。"]);
    const farm = s.find((x) => x.title === "农场外围");
    expect(farm?.source.page).toBe(2);
    expect(farm?.source.line).toBe(1);
  });

  test("条目各自记录自己的位置", () => {
    const s = sectionize(["场景：\n正文。\n▶捕兽夹：咬住腿"]);
    expect(s[0]?.items[0]?.source).toEqual({ page: 1, line: 3 });
  });
});

describe("空输入", () => {
  test("空数组返回空数组", () => {
    expect(sectionize([])).toEqual([]);
  });
  test("全是空页返回空数组", () => {
    expect(sectionize(["", "  ", ""])).toEqual([]);
  });
});
