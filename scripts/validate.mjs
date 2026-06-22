import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const loopflowsDir = path.join(root, 'loopflows');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const errors = [];

function assert(condition, message) {
  if (!condition) errors.push(message);
}

assert(pkg.name === 'pi-loopflows', 'package name must be pi-loopflows');
assert(pkg.keywords?.includes('pi-package'), 'package must include pi-package keyword');
assert(pkg.pi?.extensions?.includes('./extensions'), 'package pi manifest must expose extensions');
assert(pkg.pi?.skills?.includes('./skills'), 'package pi manifest must expose skills');

const files = fs.readdirSync(loopflowsDir).filter((file) => file.endsWith('.loopflow.json'));
assert(files.length >= 3, 'expected bundled launch-control, build-review, and plan-review loopflows');

for (const file of files) {
  const full = path.join(loopflowsDir, file);
  let wf;
  try {
    wf = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    errors.push(`${file}: invalid JSON: ${error.message}`);
    continue;
  }

  assert(typeof wf.name === 'string' && wf.name.length > 0, `${file}: missing name`);
  assert(typeof wf.description === 'string' && wf.description.length > 0, `${file}: missing description`);
  assert(Array.isArray(wf.steps) && wf.steps.length > 0, `${file}: steps must be a non-empty array`);

  const topLevelIds = new Set();
  for (const [index, node] of wf.steps.entries()) {
    if (node.loop) {
      const loop = node.loop;
      assert(typeof loop.id === 'string' && loop.id.length > 0, `${file}: loop ${index} missing id`);
      assert(Number.isInteger(loop.maxIterations) && loop.maxIterations > 0, `${file}: loop ${loop.id} maxIterations must be positive integer`);
      assert(Array.isArray(loop.body) && loop.body.length > 0, `${file}: loop ${loop.id} body must be non-empty`);
      assert(typeof loop.gateStep === 'string' && loop.gateStep.length > 0, `${file}: loop ${loop.id} missing gateStep`);
      const bodyIds = new Set(loop.body.map((step) => step.id));
      assert(bodyIds.has(loop.gateStep), `${file}: loop ${loop.id} gateStep not present in body`);
      for (const step of loop.body) validateStep(file, step, `loop ${loop.id}`);
    } else {
      validateStep(file, node, `step ${index}`);
      if (node.id) {
        assert(!topLevelIds.has(node.id), `${file}: duplicate top-level step id ${node.id}`);
        topLevelIds.add(node.id);
      }
    }
  }
}

function validateStep(file, step, label) {
  assert(typeof step.id === 'string' && step.id.length > 0, `${file}: ${label} missing id`);
  assert(typeof step.agent === 'string' && step.agent.length > 0, `${file}: ${label} missing agent`);
  assert(typeof step.task === 'string' && step.task.length > 0, `${file}: ${label} missing task`);
  if (step.gate) {
    assert(step.task.includes('JSON') || step.task.includes('json'), `${file}: gate step ${step.id} should explicitly request JSON`);
  }
}

if (errors.length) {
  console.error(errors.map((e) => `- ${e}`).join('\n'));
  process.exit(1);
}

console.log(`Validated ${files.length} loopflows for ${pkg.name}@${pkg.version}`);
