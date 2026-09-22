function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const GROUPS = {
  managers: { title: "直属上级", keyLabel: "申请人 ID", hint: "MANAGER 策略按申请人查找上级" },
  roles: { title: "角色", keyLabel: "角色 Key", hint: "ROLE 策略使用这里的角色成员" },
  departmentRoles: { title: "部门角色", keyLabel: "部门角色 Key", hint: "DEPARTMENT_ROLE 策略使用这里的成员" },
  providers: { title: "自定义 Provider", keyLabel: "Provider Key", hint: "PROVIDER 策略使用这里的解析结果" },
};

function toDraft(config) {
  return {
    people: Object.entries(config.people).map(([id, person]) => ({ id, ...person })),
    organization: Object.fromEntries(Object.keys(GROUPS).map((group) => [
      group,
      Object.entries(config.organization[group]).map(([key, members]) => ({ key, members: [...members] })),
    ])),
    notifications: structuredClone(config.notifications),
  };
}

function toConfig(draft) {
  const people = {};
  for (const person of draft.people) {
    const id = person.id.trim();
    if (id === "") throw new Error("用户 ID 不能为空");
    if (Object.hasOwn(people, id)) throw new Error(`用户 ID '${id}' 重复`);
    people[id] = { name: person.name.trim(), email: person.email.trim() };
  }
  const organization = {};
  for (const group of Object.keys(GROUPS)) {
    organization[group] = {};
    for (const mapping of draft.organization[group]) {
      const key = mapping.key.trim();
      if (key === "") throw new Error(`${GROUPS[group].title}的映射 Key 不能为空`);
      if (Object.hasOwn(organization[group], key)) throw new Error(`${GROUPS[group].title}映射 '${key}' 重复`);
      organization[group][key] = [...mapping.members];
    }
  }
  return { people, organization, notifications: structuredClone(draft.notifications) };
}

export function createHostConfigForm({ api, showToast, onSaved }) {
  const elements = {
    people: document.querySelector("#people-config-list"),
    addPerson: document.querySelector("#add-person"),
    organization: document.querySelector("#organization-config-forms"),
    notifyTask: document.querySelector("#notify-task-created"),
    notifyResult: document.querySelector("#notify-final-result"),
    save: document.querySelector("#save-host-config"),
    result: document.querySelector("#host-config-result"),
  };
  let draft;

  function setResult(message, passed) {
    elements.result.textContent = `${passed ? "✓" : "×"} ${message}`;
    elements.result.className = `config-result config-result--${passed ? "passed" : "failed"}`;
  }

  function renderPeople() {
    elements.people.innerHTML = draft.people.map((person, index) => `
      <div class="person-config-row" data-person-index="${index}">
        <label>用户 ID<input data-person-field="id" value="${escapeHtml(person.id)}" placeholder="例如 reviewer-1" /></label>
        <label>显示名称<input data-person-field="name" value="${escapeHtml(person.name)}" /></label>
        <label>通知邮箱<input data-person-field="email" type="email" value="${escapeHtml(person.email)}" /></label>
        <button class="icon-button" data-remove-person type="button" aria-label="删除用户">×</button>
      </div>
    `).join("");
  }

  function memberOptions(selected) {
    const known = draft.people.some((person) => person.id === selected);
    return `${known || selected === "" ? "" : `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}（待修复）</option>`}${draft.people.map((person) => `
      <option value="${escapeHtml(person.id)}" ${person.id === selected ? "selected" : ""}>${escapeHtml(person.name || person.id)} · ${escapeHtml(person.id)}</option>
    `).join("")}`;
  }

  function renderOrganization() {
    elements.organization.innerHTML = Object.entries(GROUPS).map(([group, meta]) => `
      <article class="organization-group" data-organization-group="${group}">
        <div class="organization-group__heading">
          <div><h4>${meta.title}</h4><p>${meta.hint}</p></div>
          <button class="button button--secondary button--small" data-add-mapping type="button">＋ 添加映射</button>
        </div>
        <div class="mapping-list">
          ${draft.organization[group].map((mapping, mappingIndex) => `
            <div class="mapping-row" data-mapping-index="${mappingIndex}">
              <div class="mapping-row__key">
                <label>${meta.keyLabel}<input data-mapping-key value="${escapeHtml(mapping.key)}" /></label>
                <button class="icon-button" data-remove-mapping type="button" aria-label="删除映射">×</button>
              </div>
              <div class="mapping-members">
                <span>解析到的用户</span>
                ${mapping.members.map((member, memberIndex) => `
                  <div class="mapping-member" data-member-index="${memberIndex}">
                    <select data-mapping-member aria-label="映射成员">${memberOptions(member)}</select>
                    <button class="icon-button" data-remove-member type="button" aria-label="删除映射成员">×</button>
                  </div>
                `).join("")}
                <button class="button button--secondary button--small" data-add-member type="button">＋ 添加成员</button>
              </div>
            </div>
          `).join("") || '<div class="empty-inline">尚未配置映射</div>'}
        </div>
      </article>
    `).join("");
  }

  function renderAll() {
    elements.notifyTask.checked = draft.notifications.taskCreated;
    elements.notifyResult.checked = draft.notifications.finalResult;
    renderPeople();
    renderOrganization();
  }

  function load(config) {
    draft = toDraft(config);
    renderAll();
    elements.result.className = "config-result";
    elements.result.textContent = "修改只影响后续新建任务和通知";
  }

  elements.notifyTask.addEventListener("change", () => { draft.notifications.taskCreated = elements.notifyTask.checked; });
  elements.notifyResult.addEventListener("change", () => { draft.notifications.finalResult = elements.notifyResult.checked; });
  elements.addPerson.addEventListener("click", () => {
    const suffix = draft.people.length + 1;
    draft.people.push({ id: `user-${suffix}`, name: `新用户 ${suffix}`, email: `user${suffix}@example.test` });
    renderAll();
  });
  elements.people.addEventListener("input", (event) => {
    const field = event.target.dataset.personField;
    if (field === undefined) return;
    const index = Number(event.target.closest("[data-person-index]").dataset.personIndex);
    if (field === "id") {
      const oldId = draft.people[index].id;
      const newId = event.target.value;
      draft.people[index].id = newId;
      for (const mappings of Object.values(draft.organization)) {
        for (const mapping of mappings) mapping.members = mapping.members.map((member) => member === oldId ? newId : member);
      }
      for (const select of elements.organization.querySelectorAll("[data-mapping-member]")) {
        const option = [...select.options].find((candidate) => candidate.value === oldId);
        if (option === undefined) continue;
        option.value = newId;
        option.textContent = option.textContent.replace(`· ${oldId}`, `· ${newId}`);
      }
      return;
    }
    draft.people[index][field] = event.target.value;
  });
  elements.people.addEventListener("change", (event) => {
    if (event.target.dataset.personField !== "id") return;
    renderAll();
  });
  elements.people.addEventListener("click", (event) => {
    const row = event.target.closest("[data-person-index]");
    if (row === null || !event.target.closest("[data-remove-person]")) return;
    draft.people.splice(Number(row.dataset.personIndex), 1);
    renderAll();
  });

  elements.organization.addEventListener("input", (event) => {
    if (!event.target.matches("[data-mapping-key]")) return;
    const group = event.target.closest("[data-organization-group]").dataset.organizationGroup;
    const mappingIndex = Number(event.target.closest("[data-mapping-index]").dataset.mappingIndex);
    draft.organization[group][mappingIndex].key = event.target.value;
  });
  elements.organization.addEventListener("change", (event) => {
    if (!event.target.matches("[data-mapping-member]")) return;
    const group = event.target.closest("[data-organization-group]").dataset.organizationGroup;
    const mappingIndex = Number(event.target.closest("[data-mapping-index]").dataset.mappingIndex);
    const memberIndex = Number(event.target.closest("[data-member-index]").dataset.memberIndex);
    draft.organization[group][mappingIndex].members[memberIndex] = event.target.value;
  });
  elements.organization.addEventListener("click", (event) => {
    const groupCard = event.target.closest("[data-organization-group]");
    if (groupCard === null) return;
    const group = groupCard.dataset.organizationGroup;
    const mappingRow = event.target.closest("[data-mapping-index]");
    const mappingIndex = Number(mappingRow?.dataset.mappingIndex);
    if (event.target.closest("[data-add-mapping]")) {
      draft.organization[group].push({ key: `${group}-key-${draft.organization[group].length + 1}`, members: [] });
    } else if (event.target.closest("[data-remove-mapping]")) {
      draft.organization[group].splice(mappingIndex, 1);
    } else if (event.target.closest("[data-add-member]")) {
      draft.organization[group][mappingIndex].members.push(draft.people[0]?.id ?? "");
    } else if (event.target.closest("[data-remove-member]")) {
      const memberIndex = Number(event.target.closest("[data-member-index]").dataset.memberIndex);
      draft.organization[group][mappingIndex].members.splice(memberIndex, 1);
    } else return;
    renderAll();
  });

  elements.save.addEventListener("click", async () => {
    elements.save.disabled = true;
    try {
      const configuration = await api("/api/config/host", {
        method: "PUT",
        body: JSON.stringify({ config: toConfig(draft) }),
      });
      load(configuration.host);
      setResult("宿主配置已保存，后续业务立即使用新配置", true);
      showToast("组织与通知配置已保存");
      await onSaved(configuration);
    } catch (error) {
      setResult(error.message, false);
    } finally {
      elements.save.disabled = false;
    }
  });

  return { load };
}
