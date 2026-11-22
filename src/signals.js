/**
 * 深月桌面脑：一轮用户文本的情绪/意图信号（纯函数，零依赖）。
 *
 * 只做关键词判断，供情绪层与人格层共用：用户累了 / 烦了 / 开心 / 道谢 / 提问 /
 * 在聊工作 / 难过；以及消息长短。不调用模型。
 */

/** 词表：每类信号的关键词。 */
const SIGNALS = Object.freeze({
  tired: ['累', '困', '熬夜', '加班', '睡不着', '失眠', '好忙', '忙死', '撑不住', '疲惫', '没力气'],
  frustrated: ['烦', '讨厌', '崩溃', '焦虑', '压力', '无语', '生气', '气死', '受不了', '郁闷', '算了'],
  joy: ['开心', '高兴', '太好了', '哈哈', '好耶', '成功', '搞定', '下班', '爽', '舒服'],
  thanks: ['谢谢', '感谢', '厉害', '好棒', '真棒', '漂亮', '可爱', '帮大忙', '辛苦了'],
  sad: ['难过', '伤心', '哭', '失望', '委屈', '孤单'],
  work: ['工作', '代码', '项目', '直播', '考试', '需求', '上线', '部署', '报告', '文档', '面试', '开会', '任务'],
})

/** 小写化后的词表（英文关键词预留）。 */
function hit(text, words) {
  const lower = text.toLowerCase()
  return words.some((word) => lower.includes(word.toLowerCase()))
}

/**
 * 分析一轮用户输入。
 * @param {string} text 用户消息。
 * @returns {{ids: string[], tired: boolean, frustrated: boolean, joy: boolean, thanks: boolean, sad: boolean, work: boolean, question: boolean, longInput: boolean, shortInput: boolean}}
 */
export function analyzeUserText(text) {
  const value = String(text ?? '')
  const ids = []
  const result = {
    ids,
    tired: hit(value, SIGNALS.tired),
    frustrated: hit(value, SIGNALS.frustrated),
    joy: hit(value, SIGNALS.joy),
    thanks: hit(value, SIGNALS.thanks),
    sad: hit(value, SIGNALS.sad),
    work: hit(value, SIGNALS.work),
    question: /[?？]/u.test(value) || /(?:吗|呢|吧|么)\s*$/u.test(value.trim()),
    longInput: value.length > 120,
    shortInput: value.trim().length > 0 && value.trim().length <= 3,
  }
  for (const key of ['tired', 'frustrated', 'joy', 'thanks', 'sad', 'work']) {
    if (result[key]) ids.push(key)
  }
  if (result.question) ids.push('question')
  return result
}

/** 给情绪/人格层用的「被夸」判断（道谢/称赞）。 */
export function isPraised(text) {
  const analysis = analyzeUserText(text)
  return analysis.thanks
}
