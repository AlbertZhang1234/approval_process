import { ApprovalError } from "../../dist/esm/index.js";

export const DEFAULT_PEOPLE = {
  "employee-1": { name: "张小明（申请人）", email: "xiaoming@example.test" },
  "employee-2": { name: "林小雨（申请人）", email: "xiaoyu@example.test" },
  "manager-1": { name: "李经理", email: "manager@example.test" },
  "finance-1": { name: "王会计", email: "finance1@example.test" },
  "finance-2": { name: "赵财务", email: "finance2@example.test" },
  "hr-1": { name: "陈人事", email: "hr@example.test" },
  "dept-manager-1": { name: "孙部门负责人", email: "dept@example.test" },
  "risk-1": { name: "周风控", email: "risk@example.test" },
  "special-1": { name: "吴特审", email: "special@example.test" },
};

export const WORKFLOW_OPTION_CATALOG = {
  nodeTypes: ["START", "APPROVAL", "CONDITION", "END"],
  approvalModes: ["ANY", "ALL"],
  assigneePolicyTypes: ["USER", "ROLE", "DEPARTMENT_ROLE", "MANAGER", "REQUEST_FIELD", "PROVIDER"],
  emptyAssigneePolicies: ["ERROR", "SKIP", "AUTO_APPROVE"],
  selfApprovalPolicies: ["ALLOW", "SKIP", "REQUIRE_OTHER"],
  conditionOperators: ["EQ", "NE", "GT", "GTE", "LT", "LTE", "IN", "NOT_IN", "EXISTS"],
};

export function createDefaultHostConfig() {
  return {
    organization: {
      managers: {
        "employee-1": ["manager-1"],
        "employee-2": ["manager-1"],
      },
      roles: {
        "finance-approver": ["finance-1", "finance-2"],
        "hr-approver": ["hr-1"],
      },
      departmentRoles: {
        "sales-manager": ["dept-manager-1"],
      },
      providers: {
        "risk-owner": ["risk-1"],
      },
    },
    people: structuredClone(DEFAULT_PEOPLE),
    notifications: {
      taskCreated: true,
      finalResult: true,
    },
  };
}

function fail(message) {
  throw new ApprovalError("INVALID_COMMAND", message);
}

function assertRecord(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${path} 必须是对象`);
}

function validateLookup(value, path) {
  assertRecord(value, path);
  for (const [key, members] of Object.entries(value)) {
    if (key.trim() === "" || !Array.isArray(members) || members.some((member) => typeof member !== "string" || member.trim() === "")) {
      fail(`${path}.${key} 必须是非空用户 ID 数组`);
    }
  }
}

export function parseHostConfig(value) {
  assertRecord(value, "config");
  assertRecord(value.organization, "config.organization");
  for (const key of ["managers", "roles", "departmentRoles", "providers"]) {
    validateLookup(value.organization[key], `config.organization.${key}`);
  }
  assertRecord(value.people, "config.people");
  for (const [userId, person] of Object.entries(value.people)) {
    assertRecord(person, `config.people.${userId}`);
    if (typeof person.name !== "string" || person.name.trim() === "") fail(`config.people.${userId}.name 不能为空`);
    if (typeof person.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(person.email)) {
      fail(`config.people.${userId}.email 不是有效邮箱`);
    }
  }
  const knownUsers = new Set(Object.keys(value.people));
  for (const [lookupName, lookup] of Object.entries(value.organization)) {
    for (const [mappingKey, members] of Object.entries(lookup)) {
      const unknownUser = members.find((member) => !knownUsers.has(member));
      if (unknownUser !== undefined) fail(`config.organization.${lookupName}.${mappingKey} 引用了未知用户 '${unknownUser}'`);
    }
  }
  assertRecord(value.notifications, "config.notifications");
  for (const key of ["taskCreated", "finalResult"]) {
    if (typeof value.notifications[key] !== "boolean") fail(`config.notifications.${key} 必须是布尔值`);
  }
  return structuredClone(value);
}

export function runtimeConfigurationView() {
  return {
    module: "createApprovalModule",
    store: "InMemoryApprovalStore（仅演示）",
    organization: "StaticOrganizationProvider（可编辑映射）",
    clock: "systemClock",
    idGenerator: "UUID",
    templateRenderer: "DefaultEmailTemplateRenderer",
    emailSender: "DemoEmailSandbox",
    transactionModel: "状态、幂等记录和 Outbox 原子保存在内存 Store",
  };
}
