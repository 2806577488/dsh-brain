// 验证修复：深夜衰减只压助手自己，不再把用户精力一起压低。
import { applyMoodDecay, applyMoodRules, MOOD_BASELINE } from '../src/mood.js'

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('ok:', msg)
}

const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString()

function freshState() {
  return {
    user: { valence: 0.35, energy: 0.30, updatedAt: threeHoursAgo },
    self: { valence: 0.55, energy: 0.40, affection: 0.5, status: '平静', updatedAt: threeHoursAgo },
  }
}

// 1) 深夜衰减：user 的 energy 不应再被 -0.05 压到 0.30 以下；self 才该降。
{
  const state = freshState()
  // 用一个「深夜」时间戳构造（本机时区 Asia/Shanghai → 03:00 触发 deep-night）
  const night = new Date('2026-11-23T03:00:00+08:00').getTime()
  state.user.updatedAt = new Date(night - 3 * 3600 * 1000).toISOString()
  state.self.updatedAt = new Date(night - 3 * 3600 * 1000).toISOString()
  const before = { user: state.user.energy, self: state.self.energy }
  applyMoodDecay(state, night, { decayMinutes: 120 })
  console.log('   user energy', before.user, '->', state.user.energy.toFixed(3))
  console.log('   self energy', before.self, '->', state.self.energy.toFixed(3))
  assert(state.user.energy >= before.user - 1e-9, '深夜衰减不再压低用户 energy')
  assert(state.self.energy < before.self, '深夜衰减仍然压低助手 energy')
}

// 2) 用户没说话（无信号）：energy 应更快回到基线（回升系数 0.10）。
{
  const state = freshState()
  state.user.updatedAt = new Date().toISOString()
  state.self.updatedAt = new Date().toISOString()
  const before = state.user.energy
  applyMoodRules(state, { userText: '' }, { now: Date.now() })
  console.log('   resting user energy', before, '->', state.user.energy.toFixed(3))
  assert(state.user.energy > before, 'resting 把用户 energy 往基线拉')
  assert(Math.abs(state.user.energy - MOOD_BASELINE.user.energy) < Math.abs(before - MOOD_BASELINE.user.energy), '距离基线更近')
}

console.log('ALL PASS')
