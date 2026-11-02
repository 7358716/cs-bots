/**
 * cs-bots 服务注册表 —— 把「已装配的域服务」与宿主 ctx 关联。
 *
 * 为什么需要它（**真实踩过的坑**，2026-11-02 临时 profile 启动实测）：
 *   Cordis 的 `ctx` **不允许任意属性赋值**：
 *     `Error: cannot set property "csBots" without provide`
 *   ⇒ 直接 `ctx.csBots = services` 会让**插件在真实宿主里加载失败**
 *     （单元测试用普通对象跑，反而发现不了 —— 这是「测了但没测真」的典型）。
 *
 * ⇒ 改用 `WeakMap<ctx, services>`：不污染宿主命名空间、不依赖 `provide`，
 *   插件卸载后随 ctx 一起被 GC。
 */

/** @type {WeakMap<object, object>} */
const registry = new WeakMap()

/**
 * 登记某个 ctx 的域服务集合。
 * @param {object} ctx
 * @param {object} services
 */
export function setServices(ctx, services) {
  if (ctx && typeof ctx === 'object') registry.set(ctx, services ?? {})
}

/**
 * 取某个 ctx 的域服务集合。未登记时返回空对象（**不抛**，让工具走降级分支）。
 * @param {object} ctx
 * @returns {{ board?: object, roster?: object, room?: object, memory?: object, dispatcher?: object }}
 */
export function getServices(ctx) {
  if (!ctx || typeof ctx !== 'object') return {}
  return registry.get(ctx) ?? {}
}
