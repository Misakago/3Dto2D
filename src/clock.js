// 计时统一走真实时钟：演示录制时 performance.now 被虚拟时钟接管，耗时统计仍需反映真实计算时间
export const now = () => (window.__realNow ? window.__realNow() : performance.now());
