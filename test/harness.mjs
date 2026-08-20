let passed = 0;
let failed = 0;
const failures = [];

export function eq(actual, expected, label) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push(`${label}\n      expected: ${expected}\n      actual:   ${actual}`);
  }
}

export function ok(cond, label) {
  eq(Boolean(cond), true, label);
}

export function section(name) {
  console.log(`\n  ${name}`);
}

export function report() {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log(`\n  FAIL: ${f}`);
  return failed;
}
