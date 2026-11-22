/**
 * DSH 助手大脑（Host 插件 bundle 根入口 / 兼容入口）。
 *
 * 正式安装把 4 个独立 Host 插件行写进 bundle 的 `cordis.patch.yml`：
 *   - dsh-memory   记忆层      → Service `brainMemory`
 *   - dsh-mood     情绪层      → Service `brainMood`
 *   - dsh-persona  人格收集层  → Service `brainPersona`
 *   - dsh-context  上下文整理层 → Service `brainContext`（注入 system prompt + /brain 命令）
 *
 * 包根入口是**兼容薄入口**：如果某个 profile 里还留着指向包根的旧行
 * （`name: '@shenyue/dsh-brain'`），它只会挂起上下文整理层（注入 + 命令），
 * 四层数据仍由各自的子路径行提供。新配置请直接用 4 个子路径行。
 */

export { name, inject, apply } from './src/plugins/context.js'
