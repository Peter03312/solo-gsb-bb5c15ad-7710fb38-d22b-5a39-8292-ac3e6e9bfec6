'use strict';

const {
  optionAvailable,
  applyChanges,
  formatStateValues,
  initialMask,
} = require('./scenario');

const { newSessionCode } = require('./db');

function nodesById(content) {
  return new Map(content.nodes.map((n) => [n.id, n]));
}

// 加载某会话绑定版本的冻结内容
function loadVersionContent(db, session) {
  const row = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(session.scenario_id, session.version);
  return row ? JSON.parse(row.content) : null;
}

// 分支血缘信息：本会话从哪个源会话的哪个分歧步而来，沿链追溯到根会话
function branchInfo(db, session) {
  if (!session.parent_code) return null;
  const chain = [];
  const seen = new Set();
  let cur = session;
  while (cur && cur.parent_code && !seen.has(cur.code)) {
    seen.add(cur.code);
    chain.unshift({ code: cur.code, parentCode: cur.parent_code, forkStepNo: cur.fork_step_no });
    cur = db.prepare('SELECT * FROM sessions WHERE code = ?').get(cur.parent_code);
  }
  return {
    parentCode: session.parent_code,
    forkStepNo: session.fork_step_no,
    rootCode: cur ? cur.code : session.parent_code,
    chain, // 从根的直接分支开始，到本会话为止
  };
}

/**
 * 从历史局面创建可继续选择的分支。
 * 沿用源会话绑定的冻结版本；保留分歧步之前（含分歧步现场）已完成的路径；
 * 分歧步为 0 时使用该版本初态；后续选择只推进分支，源会话与其它分支不变。
 * 入参：{ source, divergenceStepNo, sourceStepNo, traineeName }
 * 失败返回 { ok:false, status, errorCode, error, sourceCurrentStepNo?, current? }，不创建。
 * 成功返回 { ok:true, session, content }。
 */
function performFork(db, { source, divergenceStepNo, sourceStepNo, traineeName }) {
  // 1) 源会话存在
  if (!source) {
    return { ok: false, status: 404, errorCode: 'SESSION_NOT_FOUND', error: '源会话不存在' };
  }
  // 2) 绑定版本存在
  const content = loadVersionContent(db, source);
  if (!content) {
    return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '源会话绑定的冻结版本内容缺失，无法分叉' };
  }

  const fail = (status, errorCode, error) => ({
    ok: false,
    status,
    errorCode,
    error,
    sourceCurrentStepNo: source.step_no,
    sourceStatus: source.status,
  });

  // 3) 乐观校验：所见的源当前步号必须与源会话当前步号一致（源会话已被推进则拒绝）
  if (!Number.isInteger(sourceStepNo) || sourceStepNo !== source.step_no) {
    return fail(409, 'STEP_STALE',
      `源会话步号已变化：你所见为第 ${sourceStepNo} 步，源会话当前为第 ${source.step_no} 步，未创建分支。请刷新源会话现状后重试`);
  }

  // 4) 分歧点越界：必须是 0..源当前步号 之间的整数
  if (!Number.isInteger(divergenceStepNo) ||
      divergenceStepNo < 0 || divergenceStepNo > source.step_no) {
    return fail(400, 'FORK_STEP_OUT_OF_RANGE',
      `分歧步号越界：第 ${divergenceStepNo} 步不存在；源会话当前到第 ${source.step_no} 步，可在第 0～${source.step_no} 步处分叉`);
  }

  const sourcePath = JSON.parse(source.path || '[]');
  const nodeMap = nodesById(content);

  // 5) 还原分歧步现场：第 0 步为版本初态；之后从源路径取该步完成后的局面
  let nodeId;
  let stateMask;
  if (divergenceStepNo === 0) {
    nodeId = content.startNodeId;
    stateMask = initialMask(content);
  } else {
    const seg = sourcePath.find((p) => p.step === divergenceStepNo);
    if (!seg) {
      return fail(400, 'FORK_STEP_OUT_OF_RANGE',
        `分歧步号越界：源会话路径中不存在第 ${divergenceStepNo} 步的现场记录`);
    }
    nodeId = seg.toNodeId;
    stateMask = seg.stateMask;
  }

  // 6) 结局步不得分叉（已结束会话只可从此前的非结局步分叉）
  const forkNode = nodeMap.get(nodeId);
  if (!forkNode) {
    return fail(500, 'FORK_NODE_MISSING', '分歧步对应节点在冻结版本中不存在，无法分叉');
  }
  if (forkNode.isEnd) {
    return fail(409, 'FORK_AT_ENDING_STEP',
      `第 ${divergenceStepNo} 步是结局步（${forkNode.title}），结局步不得分叉；请选择此前的非结局步`);
  }

  // 保留到达分歧步现场之前已完成的路径（路径项 step k 表示“第 k-1 步的选择”，
  // 即到达第 k 步现场的那一步；故分歧步 d 的现场由 step === d 的路径项到达，需一并保留）。
  // 分支下一步推进时记录为 step d+1，不与既有路径冲突。
  const inheritedPath = sourcePath.filter((p) => p.step <= divergenceStepNo);

  const code = newSessionCode();
  const name = typeof traineeName === 'string' && traineeName.trim()
    ? traineeName.trim().slice(0, 100)
    : source.trainee_name;
  db.prepare(`
    INSERT INTO sessions
      (code, scenario_id, version, current_node_id, state_mask, step_no, status, path,
       trainee_name, parent_code, fork_step_no)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(code, source.scenario_id, source.version, nodeId, stateMask, divergenceStepNo,
    JSON.stringify(inheritedPath), name ?? null, source.code, divergenceStepNo);

  const session = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
  return { ok: true, session, content };
}

// 加载整条分支血缘：沿 parent_code 向上到根，再附源会话的直接分支们，供对照
function loadLineage(db, code) {
  const start = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
  if (!start) return null;

  const ancestors = [];
  const seen = new Set();
  let cur = start;
  while (cur && !seen.has(cur.code)) {
    seen.add(cur.code);
    ancestors.push(cur);
    if (!cur.parent_code) break;
    cur = db.prepare('SELECT * FROM sessions WHERE code = ?').get(cur.parent_code);
  }
  const root = ancestors[ancestors.length - 1];

  const scenarios = new Map();
  const getTitle = (scenarioId) => {
    if (!scenarios.has(scenarioId)) {
      const r = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(scenarioId);
      scenarios.set(scenarioId, r ? r.title : null);
    }
    return scenarios.get(scenarioId);
  };

  // 根会话及其全部后代（按父子关系一层一层取出）
  const byCode = new Map();
  const queue = [root];
  const rows = [];
  const enqueued = new Set([root.code]);
  while (queue.length) {
    const s = queue.shift();
    byCode.set(s.code, s);
    const children = db.prepare('SELECT * FROM sessions WHERE parent_code = ? ORDER BY created_at, code')
      .all(s.code);
    for (const c of children) {
      rows.push({ child: c, parent: s });
      if (!enqueued.has(c.code)) {
        enqueued.add(c.code);
        queue.push(c);
      }
    }
  }

  const describe = (s) => {
    const c = loadVersionContent(db, s);
    return {
      ...(c ? buildSnapshot(c, s, s.scenario_id, s.version)
           : { code: s.code, scenarioId: s.scenario_id, version: s.version,
               status: s.status, stepNo: s.step_no, path: [], availableOptions: [],
               unavailableOptions: [], states: [], currentNode: null,
               traineeName: s.trainee_name || null, startedAt: s.created_at }),
      scenarioTitle: getTitle(s.scenario_id),
      branch: branchInfo(db, s),
    };
  };

  return {
    scenarioId: root.scenario_id,
    root: describe(root),
    ancestry: ancestors.slice().reverse().map(describe), // 根 → … → 本会话
    // 全树会话（含旁支），供对照时取任意源会话的后续路径
    sessions: Array.from(byCode.values()).map(describe),
    forks: rows.map(({ child, parent }) => ({
      parent: describe(parent),
      forkStepNo: child.fork_step_no,
      branch: describe(child),
    })),
  };
}

// 构造返回给前端的完整现状快照
function buildSnapshot(content, session, scenarioId, version) {
  const nodeMap = nodesById(content);
  const node = nodeMap.get(session.current_node_id);
  const stateValues = formatStateValues(content, session.state_mask);
  const path = JSON.parse(session.path || '[]');

  const available = [];
  const unavailable = [];
  if (node && !node.isEnd && session.status === 'active') {
    for (const o of node.options) {
      const ok = optionAvailable(o, session.state_mask, content);
      const failing = o.conditions
        .filter((c) => {
          const st = content.states.find((s) => s.id === c.stateId);
          const cur = stateValues.find((v) => v.id === c.stateId);
          return st && cur && cur.value !== c.value;
        })
        .map((c) => {
          const st = content.states.find((s) => s.id === c.stateId);
          return { stateId: c.stateId, stateName: st ? st.name : c.stateId, required: c.value };
        });
      const item = {
        id: o.id,
        label: o.label,
        conditions: o.conditions,
        changes: o.changes,
        toNodeId: o.toNodeId,
      };
      if (ok) available.push(item);
      else unavailable.push({ ...item, reason: '当前现场状态不满足该选项条件', failingConditions: failing });
    }
  }

  const pathView = path.map((p) => {
    const fromNode = nodeMap.get(p.fromNodeId);
    const toNode = nodeMap.get(p.toNodeId);
    const fromN = fromNode ? fromNode.options.find((o) => o.id === p.optionId) : null;
    return {
      step: p.step,
      fromNodeId: p.fromNodeId,
      fromNodeTitle: fromNode ? fromNode.title : p.fromNodeId,
      optionId: p.optionId,
      optionLabel: fromN ? fromN.label : p.optionId,
      toNodeId: p.toNodeId,
      toNodeTitle: toNode ? toNode.title : p.toNodeId,
      stateAfter: formatStateValues(content, p.stateMask),
    };
  });

  return {
    code: session.code,
    scenarioId,
    version,
    status: session.status,
    stepNo: session.step_no,
    currentNode: node ? {
      id: node.id,
      title: node.title,
      narrative: node.narrative,
      isEnd: node.isEnd,
    } : null,
    states: stateValues,
    availableOptions: available,
    unavailableOptions: unavailable,
    path: pathView,
    traineeName: session.trainee_name || null,
    startedAt: session.created_at,
  };
}

/**
 * 执行一步选择。不写库，返回 {ok, error, session}（供事务内调用）。
 * 校验：会话存在/未结束、步号严格匹配当前步号（防过期/重复提交）、
 *       选项属于当前节点、条件满足。任何不满足都不推进。
 */
function performMove(db, { code, optionId, stepNo, traineeName }) {
  const session = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
  if (!session) {
    return { ok: false, status: 404, errorCode: 'SESSION_NOT_FOUND', error: '会话不存在' };
  }
  const versionRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(session.scenario_id, session.version);
  if (!versionRow) {
    return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '会话所绑定的版本内容缺失' };
  }
  const content = JSON.parse(versionRow.content);
  const nodeMap = nodesById(content);

  const fail = (status, errorCode, error) => ({
    ok: false,
    status,
    errorCode,
    error,
    current: buildSnapshot(content, session, session.scenario_id, session.version),
  });

  if (session.status !== 'active') {
    return fail(409, 'SESSION_ENDED', '该会话已结束，不能继续选择');
  }
  if (!Number.isInteger(stepNo) || stepNo !== session.step_no) {
    return fail(409, 'STEP_STALE',
      `步号不匹配：请求携带第 ${stepNo} 步，会话当前为第 ${session.step_no} 步（可能是过期或重复的选择，未推进）`);
  }
  const node = nodeMap.get(session.current_node_id);
  if (!node || node.isEnd) {
    return fail(409, 'NODE_NOT_CHOOSABLE', '当前节点不是可选择节点');
  }
  const option = node.options.find((o) => o.id === optionId);
  if (!option) {
    return fail(400, 'OPTION_NOT_FOUND', '当前节点下不存在该选项');
  }
  if (!optionAvailable(option, session.state_mask, content)) {
    const failing = option.conditions
      .filter((c) => {
        const i = content.states.findIndex((s) => s.id === c.stateId);
        const cur = i >= 0 ? ((session.state_mask >> i) & 1) === 1 : null;
        return cur !== null && cur !== c.value;
      })
      .map((c) => {
        const st = content.states.find((s) => s.id === c.stateId);
        return `${st ? st.name : c.stateId} 需要为「${c.value ? '是' : '否'}」`;
      });
    return fail(409, 'CONDITION_NOT_MET',
      `当前现场状态不满足选项「${option.label}」的条件${failing.length ? '：' + failing.join('；') : ''}`);
  }

  const newMask = applyChanges(option, session.state_mask, content);
  const nextStep = session.step_no + 1;
  const path = JSON.parse(session.path || '[]');
  path.push({
    step: nextStep,
    fromNodeId: node.id,
    optionId: option.id,
    toNodeId: option.toNodeId,
    stateMask: newMask,
  });
  const targetNode = nodeMap.get(option.toNodeId);
  const newStatus = targetNode && targetNode.isEnd ? 'ended' : 'active';

  db.prepare(`
    UPDATE sessions
       SET current_node_id = ?, state_mask = ?, step_no = ?, status = ?,
           path = ?, trainee_name = COALESCE(?, trainee_name), updated_at = datetime('now')
     WHERE code = ?
  `).run(option.toNodeId, newMask, nextStep, newStatus, JSON.stringify(path),
    traineeName ?? null, code);

  const updated = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
  return { ok: true, session: updated, content };
}

module.exports = {
  buildSnapshot,
  performMove,
  performFork,
  branchInfo,
  loadLineage,
  loadVersionContent,
  nodesById,
};
