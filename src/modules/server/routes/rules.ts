// src/modules/server/routes/rules.ts
// 规则引擎路由（转发到 rules 模块的 routes 实现；保持 server 路由文件组织惯例）。

export {
  createListRulesHandler,
  createCreateRuleHandler,
  createGetRuleHandler,
  createUpdateRuleHandler,
  createDeleteRuleHandler,
  createClearRulesHandler,
} from '../../rules/api/routes';
