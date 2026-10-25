import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function definition(name) {
  return JSON.parse(await readFile(new URL(`../../../infra/workflows/${name}-world.asl.json`, import.meta.url), 'utf8').catch(() =>
    readFile(new URL(`../../../../infra/workflows/${name}-world.asl.json`, import.meta.url), 'utf8')));
}

function matchesChoice(rule, data) {
  if (rule.And) return rule.And.every(condition => matchesChoice(condition, data));
  const value = rule.Variable.split('.').slice(1).reduce((object, key) => object?.[key], data);
  if ('IsPresent' in rule) return (value !== undefined) === rule.IsPresent;
  if (value === undefined) {
    throw Object.assign(new Error(`Invalid Choice path: ${rule.Variable}`), { name: 'States.Runtime' });
  }
  return value === rule.BooleanEquals;
}

/** Local contract runner for the subset used here. It doesn't emulate AWS IAM or service availability. */
export async function runWorkflow(asl, handler, input, { wait = async () => {}, trace = [], executionArn } = {}) {
  let state = asl.StartAt;
  const data = { ...input };
  for (let iterations = 0; iterations < 200; iterations++) {
    const node = asl.States[state];
    assert.ok(node, `Missing state ${state}`);
    trace.push(state);
    if (node.Type === 'Succeed') return { status: 'SUCCEEDED', trace, data };
    if (node.Type === 'Fail') return { status: 'FAILED', trace, data };
    if (node.Type === 'Task') {
      try {
        data.task = await handler({ action: node.Parameters.action, operationId: data.operationId,
          executionArn: executionArn || `arn:aws:states:us-east-1:123456789012:execution:local:${data.operationId}` }, {});
        state = node.Next;
      } catch (err) {
        data.failure = { Error: err.name };
        state = node.Catch[0].Next;
      }
    } else if (node.Type === 'Wait') {
      await wait(node.Seconds);
      state = node.Next;
    } else if (node.Type === 'Choice') {
      state = node.Choices.find(rule => matchesChoice(rule, data))?.Next || node.Default;
    } else throw new Error(`Unsupported local state type: ${node.Type}`);
  }
  throw new Error('Workflow exceeded local iteration limit');
}

export function validateTransitions(asl) {
  assert.ok(asl.States[asl.StartAt]);
  for (const [name, state] of Object.entries(asl.States)) {
    for (const next of [state.Next, state.Default, ...((state.Choices || []).map(c => c.Next)), ...((state.Catch || []).map(c => c.Next))].filter(Boolean)) {
      assert.ok(asl.States[next], `${name} targets missing state ${next}`);
    }
    if (state.Type === 'Task') assert.ok(state.TimeoutSeconds < 45);
  }
}
