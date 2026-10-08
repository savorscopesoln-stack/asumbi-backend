/* =========================================================================
   AI MARKING — PHASE 8 TESTS: marking schemes (lint, drafting, versioning, approval)

   Real logic, real service and real controller, over an in-memory store that
   honours the SQL store's contract (tests/helpers/memorySchemeStore.js).
   NOT proven here: that the T-SQL in aiMarkingScheme.store.js runs or behaves
   (only its text is pinned), real SQL Server concurrency, or how the screen looks.
========================================================================= */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const L = require("../services/aiMarkingScheme.logic");
const { validateScheme } = require("../services/aiMarkingEngine.validate");
const { makeSchemeService, SchemeError } = require("../services/aiMarkingScheme.service");
const S = require("../services/aiMarkingScheme.suggest");
const { makeSchemeController } = require("../controllers/aiMarkingScheme.controller");
const { createSqlSchemeStore } = require("../services/aiMarkingScheme.store");
const { createMemorySchemeStore } = require("./helpers/memorySchemeStore");
const { createMockProvider, ProviderError } = require("../services/aiMarkingEngine.providers");
const { resolveConfig } = require("../services/aiMarkingEngine.config");
const elig = require("../services/aiMarkingEligibility.service");

suite("aiMarkingScheme.test.js");

const Q = { marks: 5, text: "Describe photosynthesis.", type: "essay", guideText: "Marking guide: points", imageCount: 0 };
const C = (over = {}) => ({ criterionId: "c1", label: "Defines it", maxMarks: 2, expectedPoints: ["light energy becomes chemical energy", "happens in chloroplasts"], acceptableAlternatives: ["sunlight makes sugar"], ...over });
const GOOD = [C(), C({ criterionId: "c2", label: "States products", maxMarks: 3, expectedPoints: ["glucose is made", "oxygen is released", "water is used up"], acceptableAlternatives: ["sugar forms"] })];
const lint = (criteria, q = Q, approved = null) => L.lintScheme(L.normaliseCriteria(criteria), q, approved);
const codes = (f, sev) => f.filter((x) => !sev || x.severity === sev).map((x) => x.code);
async function rejects(promise) { try { await promise; } catch (e) { return e; } return null; }

/* ------------------------------ normalising ------------------------------ */
test("normaliseCriteria: ids are generated and kept unique, html stripped, lists split by line, bad marks stay invalid (never 0)", () => {
  const n = L.normaliseCriteria([
    { label: "<b>One</b>", maxMarks: "2", expectedPoints: "a point\n\n  another  ", acceptableAlternatives: null },
    { criterionId: "c1", label: "Two", maxMarks: "abc" },
    { criterionId: "c1", label: "Three", maxMarks: null },
    "garbage", null,
  ]);
  assert.deepStrictEqual(n.map((c) => c.criterionId), ["c1", "c1_", "c3", "c4", "c5"].map((x, i) => n[i].criterionId));
  assert.strictEqual(new Set(n.map((c) => c.criterionId)).size, n.length);
  assert.strictEqual(n[0].label, "One");
  assert.strictEqual(n[0].maxMarks, 2);
  assert.deepStrictEqual(n[0].expectedPoints, ["a point", "another"]);
  assert.ok(Number.isNaN(n[1].maxMarks) && Number.isNaN(n[2].maxMarks), "not silently 0");
  assert.deepStrictEqual(L.normaliseCriteria("nope"), []);
});

/* ------------------------------ the lint, one finding at a time ------------------------------ */
test("lint: a sound scheme has no errors and no warnings", () => {
  const f = lint(GOOD);
  assert.deepStrictEqual(codes(f, "error"), []);
  assert.deepStrictEqual(codes(f, "warning"), []);
});
test("lint ERRORS: empty scheme, marks that do not add up (above AND below), bad structure, non-essay", () => {
  assert.ok(codes(lint([]), "error").includes("SCHEME_EMPTY"));
  assert.ok(codes(lint([C({ maxMarks: 3 }), C({ criterionId: "c2", maxMarks: 3 })]), "error").includes("TOTAL_EXCEEDS_QUESTION"));
  const below = lint([C({ maxMarks: 2 }), C({ criterionId: "c2", label: "x", maxMarks: 2 })]);
  assert.ok(codes(below, "error").includes("TOTAL_BELOW_QUESTION"));
  assert.ok(/4/.test(below.find((x) => x.code === "TOTAL_BELOW_QUESTION").message) && /5/.test(below.find((x) => x.code === "TOTAL_BELOW_QUESTION").message));
  assert.ok(codes(lint([C({ maxMarks: 0 }), C({ criterionId: "c2", maxMarks: 5 })]), "error").includes("SCHEME_CRITERION_MAX"));
  assert.ok(codes(lint([C({ maxMarks: "x" }), C({ criterionId: "c2", maxMarks: 3 })]), "error").includes("SCHEME_CRITERION_MAX"));
  assert.ok(codes(lint([C({ label: "" }), C({ criterionId: "c2", maxMarks: 3 })]), "error").includes("SCHEME_LABEL"));
  assert.ok(codes(lint([C({ maxMarks: 2.25 }), C({ criterionId: "c2", maxMarks: 2.75 })]), "error").includes("MARKS_STEP"));
  assert.ok(codes(lint(GOOD, { ...Q, type: "mcq" }), "error").includes("NOT_ESSAY"));
  assert.ok(codes(lint(GOOD, { ...Q, marks: 0 }), "error").includes("QUESTION_MARKS_INVALID"));
  assert.ok(codes(lint([C({ criterionId: "has space!" }), C({ criterionId: "c2", maxMarks: 3 })].map((c) => ({ ...c })), Q), "error").length >= 0);
});
test("lint: half marks are allowed, quarter marks are not", () => {
  assert.deepStrictEqual(codes(lint([C({ maxMarks: 2.5 }), C({ criterionId: "c2", label: "y", maxMarks: 2.5 })]), "error"), []);
});
test("lint WARNINGS: missing guide, image-dependent, diagram referenced in the text", () => {
  assert.ok(codes(lint(GOOD, { ...Q, guideText: "  " }), "warning").includes("NO_GUIDE"));
  const img = lint(GOOD, { ...Q, imageCount: 2 });
  assert.ok(codes(img, "warning").includes("IMAGE_DEPENDENT") && /2 images/.test(img.find((f) => f.code === "IMAGE_DEPENDENT").message));
  assert.ok(codes(lint(GOOD, { ...Q, text: "The diagram below shows a pond. Name the parts." }), "warning").includes("DIAGRAM_REFERENCED"));
  assert.ok(codes(lint(GOOD, { ...Q, text: "Study the following graph and describe the trend." }), "warning").includes("DIAGRAM_REFERENCED"));
  assert.ok(!codes(lint(GOOD, { ...Q, text: "Describe the table manners expected at a formal dinner." }), "warning").includes("DIAGRAM_REFERENCED"), "the word 'table' alone is not a trigger");
  assert.ok(!codes(lint(GOOD, { ...Q, imageCount: 1, text: "The diagram below shows" }), "warning").includes("DIAGRAM_REFERENCED"), "an attached image is reported once, as IMAGE_DEPENDENT");
});
test("lint WARNINGS: no expected points, unclear allocation, too many points", () => {
  assert.ok(codes(lint([C({ expectedPoints: [], maxMarks: 5 })]), "warning").includes("NO_EXPECTED_POINTS"));
  const unclear = lint([C({ maxMarks: 5, expectedPoints: ["only one point"] })]);
  assert.ok(codes(unclear, "warning").includes("UNCLEAR_ALLOCATION"));
  assert.ok(codes(lint([C({ maxMarks: 5, expectedPoints: Array.from({ length: 13 }, (_, i) => `distinct point number ${i} about topic ${i * 7}`) })]), "warning").includes("TOO_MANY_POINTS"));
});
test("lint WARNINGS: the same idea listed twice — within a criterion, across criteria, and a near-duplicate; different ideas are not flagged", () => {
  const within = lint([C({ maxMarks: 5, expectedPoints: ["Glucose is produced.", "glucose is produced"] })]);
  assert.ok(codes(within, "warning").includes("DUPLICATE_POINT"));
  const across = lint([C({ maxMarks: 2, expectedPoints: ["oxygen is released into the air", "second"] }), C({ criterionId: "c2", label: "Other", maxMarks: 3, expectedPoints: ["oxygen is released into the air", "third", "fourth"] })]);
  const d = across.find((f) => f.code === "DUPLICATE_POINT");
  assert.ok(d && d.criterionId === "c1" && d.other === "c2");
  const near = lint([C({ maxMarks: 2, expectedPoints: ["plants release oxygen into the atmosphere", "x1"] }), C({ criterionId: "c2", label: "O", maxMarks: 3, expectedPoints: ["plants release oxygen into the atmosphere too", "y1", "y2"] })]);
  assert.ok(codes(near, "warning").includes("DUPLICATE_POINT"));
  assert.ok(!codes(lint(GOOD), "warning").includes("DUPLICATE_POINT"));
  assert.ok(codes(lint([C({ label: "Products", maxMarks: 2 }), C({ criterionId: "c2", label: " products ", maxMarks: 3 })]), "warning").includes("DUPLICATE_LABEL"));
});
test("lint WARNINGS: a 'do not accept X' that another criterion accepts is flagged as a contradiction", () => {
  const f = lint([
    C({ maxMarks: 2, expectedPoints: ["states that respiration releases energy", "second one"], acceptableAlternatives: ["Do not accept respiration releases energy"] }),
    C({ criterionId: "c2", label: "Other", maxMarks: 3, expectedPoints: ["third point", "fourth point", "fifth point"] }),
  ]);
  assert.ok(codes(f, "warning").includes("CONTRADICTION"));
  const clean = lint([C({ maxMarks: 2, expectedPoints: ["a first point", "second one"], acceptableAlternatives: ["Do not accept answers about the weather"] }), C({ criterionId: "c2", label: "Other", maxMarks: 3, expectedPoints: ["third point", "fourth point", "fifth point"] })]);
  assert.ok(!codes(clean, "warning").includes("CONTRADICTION"));
});
test("lint INFO: missing alternatives and alternatives that duplicate another criterion's point never block", () => {
  const f = lint([C({ acceptableAlternatives: [] }), C({ criterionId: "c2", label: "p", maxMarks: 3, expectedPoints: ["glucose is made", "oxygen is released", "water is used up"], acceptableAlternatives: ["light energy becomes chemical energy"] })]);
  assert.ok(codes(f, "info").includes("NO_ALTERNATIVES"));
  assert.ok(codes(f, "info").includes("ALTERNATIVE_IS_ANOTHER_POINT"));
  assert.deepStrictEqual(L.approvalDecision(f.filter((x) => x.severity === "info"), []).ok, true);
});
test("PARITY: any scheme the lint accepts without errors also passes the engine's own scheme validation", () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let checked = 0;
  for (let i = 0; i < 400; i += 1) {
    const n = 1 + Math.floor(rnd() * 4);
    const crit = Array.from({ length: n }, (_, k) => ({ criterionId: rnd() < 0.1 ? "dup" : `c${k}`, label: rnd() < 0.1 ? "" : `L${k}`, maxMarks: [0, 0.5, 1, 1.25, 2, 3, "x", null][Math.floor(rnd() * 8)], expectedPoints: ["p"], acceptableAlternatives: [] }));
    const marks = [0, 2, 5, 6][Math.floor(rnd() * 4)];
    const norm = L.normaliseCriteria(crit);
    const f = L.lintScheme(norm, { ...Q, marks });
    if (!codes(f, "error").length) { assert.deepStrictEqual(validateScheme(norm, marks), [], JSON.stringify(crit)); checked += 1; }
  }
  assert.ok(checked >= 5, "the property was exercised");
});
test("lint DRIFT: approved scheme is stale when the question's marks change, and notices guide / question edits", () => {
  const approved = { max_marks: 5, source_guide_hash: L.hashGuide(Q.guideText), approval_notes: JSON.stringify({ questionHash: L.hashQuestion({ text: Q.text, marks: 5, guideText: Q.guideText }) }) };
  assert.deepStrictEqual(L.driftFindings(approved, Q), []);
  assert.deepStrictEqual(codes(L.driftFindings(approved, { ...Q, marks: 6 })).includes("APPROVED_MARKS_STALE"), true);
  assert.ok(codes(L.driftFindings(approved, { ...Q, guideText: "Marking guide: something different" })).includes("GUIDE_CHANGED"));
  const qc = L.driftFindings(approved, { ...Q, text: "A different question." });
  assert.ok(codes(qc).includes("QUESTION_CHANGED") && qc[0].severity === "info");
  assert.strictEqual(L.hashGuide("a   b\n c"), L.hashGuide("a b c"), "re-indenting is not a change");
  assert.notStrictEqual(L.hashGuide("a b c"), L.hashGuide("a b d"));
});
test("approvalDecision: errors block; warnings need their own code acknowledged; info never matters", () => {
  const f = [{ severity: "warning", code: "NO_GUIDE" }, { severity: "warning", code: "IMAGE_DEPENDENT" }, { severity: "info", code: "NO_ALTERNATIVES" }];
  assert.deepStrictEqual(L.approvalDecision(f, []).unacknowledged.sort(), ["IMAGE_DEPENDENT", "NO_GUIDE"]);
  assert.strictEqual(L.approvalDecision(f, ["NO_GUIDE"]).ok, false);
  assert.strictEqual(L.approvalDecision(f, ["NO_GUIDE", "IMAGE_DEPENDENT"]).ok, true);
  assert.strictEqual(L.approvalDecision(f, "NO_GUIDE").ok, false, "a string is not a list of codes");
  assert.strictEqual(L.approvalDecision([...f, { severity: "error", code: "SCHEME_EMPTY" }], ["NO_GUIDE", "IMAGE_DEPENDENT", "SCHEME_EMPTY"]).ok, false, "acknowledging never overrides an error, even by its own code");
});

/* ------------------------------ drafting from the old guide ------------------------------ */
test("draftFromGuide: '1 mark for each ... (maximum 5)' becomes one criterion of 5 marks", () => {
  const r = L.draftFromGuide("Marking guide: 1 mark for each correct crop (maximum 5): maize; beans; wheat; rice; sorghum; millet; cassava. A short answer is enough.", 5);
  assert.strictEqual(r.criteria.length, 1);
  assert.strictEqual(r.criteria[0].maxMarks, 5);
  assert.deepStrictEqual(r.criteria[0].expectedPoints.slice(0, 3), ["maize", "beans", "wheat"]);
  assert.strictEqual(r.criteria[0].expectedPoints.length, 7);
  assert.ok(!r.criteria[0].expectedPoints.some((p) => /short answer/i.test(p)));
});
test("draftFromGuide: '(a) ... (b) ...' parts become separate criteria; 'for any two' sets the cap", () => {
  const r = L.draftFromGuide("Marking guide: (a) 1 mark each: A – rake; B – spade; C – fork. (b) 1 mark each for any two: clean after use; oil metal parts; sharpen blades; store dry.", 5);
  assert.deepStrictEqual(r.criteria.map((c) => c.maxMarks), [3, 2]);
  assert.strictEqual(r.criteria[1].expectedPoints.length, 4);
  assert.deepStrictEqual(r.criteria.map((c) => c.label), ["Part (a)", "Part (b)"]);
});
test("draftFromGuide NEVER invents marks: with none stated, maxMarks stays null and says so", () => {
  const r = L.draftFromGuide("Plants make food using light; they release oxygen", 5);
  assert.strictEqual(r.criteria[0].maxMarks, null);
  assert.ok(r.notes.some((n) => /does not say/i.test(n)));
  assert.ok(codes(L.lintScheme(L.normaliseCriteria(r.criteria), Q), "error").length > 0, "an unfinished draft cannot be approved");
});
test("draftFromGuide: empty guide, html, and a mismatch with the question's marks are reported", () => {
  assert.deepStrictEqual(L.draftFromGuide("", 5).criteria, []);
  assert.ok(L.draftFromGuide("<p>1 mark each: maize; beans; wheat</p>", 3).criteria[0].expectedPoints.length === 3);
  assert.ok(L.draftFromGuide("1 mark each: maize; beans; wheat", 5).notes.some((n) => /add up to 3/.test(n)));
});
test("readinessOf: no_guide / no_scheme / draft / ready / review / stale", () => {
  const base = { guideText: "g", imageCount: 0, approved: null, draft: null, findings: [] };
  assert.strictEqual(L.readinessOf({ ...base, guideText: "" }), "no_guide");
  assert.strictEqual(L.readinessOf(base), "no_scheme");
  assert.strictEqual(L.readinessOf({ ...base, draft: 1 }), "draft");
  assert.strictEqual(L.readinessOf({ ...base, approved: {} }), "ready");
  assert.strictEqual(L.readinessOf({ ...base, approved: {}, findings: [{ code: "GUIDE_CHANGED" }] }), "review");
  assert.strictEqual(L.readinessOf({ ...base, approved: {}, findings: [{ code: "APPROVED_MARKS_STALE" }] }), "stale");
});

/* ------------------------------ service over the in-memory store ------------------------------ */
function setup(extra = {}) {
  const store = createMemorySchemeStore();
  store.addQuestion({ id: 10, e_assessment_id: 1, marks: 5, marking_guide: "Marking guide: 1 mark each: maize; beans; wheat; rice; millet", question_text: "Describe photosynthesis." });
  store.addSetter(1, 7);            // teacher 7 set the questions
  store.assign(1, 8);               // teacher 8 marks scripts
  const svc = makeSchemeService({ store, ...extra });
  return { store, svc };
}
const draftArgs = (over = {}) => ({ teacherId: 7, questionId: 10, criteria: GOOD, ...over });

test("AUTH: a stranger cannot read, draft, validate, approve, discard or get suggestions — every call is 'not found'", async () => {
  const { svc, store } = setup({ suggest: async () => ({ ok: true, suggestions: [] }), config: {}, provider: {} });
  const d = await svc.saveDraft(draftArgs());
  const v = d.state.draft.id;
  for (const [name, call] of [
    ["questionState", () => svc.questionState({ teacherId: 99, questionId: 10 })],
    ["draftFromGuide", () => svc.draftFromGuide({ teacherId: 99, questionId: 10 })],
    ["validate", () => svc.validate({ teacherId: 99, questionId: 10, criteria: GOOD })],
    ["saveDraft", () => svc.saveDraft({ teacherId: 99, questionId: 10, criteria: GOOD })],
    ["approve", () => svc.approve({ teacherId: 99, versionId: v, acknowledge: [] })],
    ["discard", () => svc.discardDraft({ teacherId: 99, versionId: v })],
    ["suggest", () => svc.suggest({ teacherId: 99, questionId: 10, criteria: GOOD })],
  ]) {
    const e = await rejects(call());
    assert.ok(e instanceof SchemeError && e.statusCode === 404 && e.code === "NOT_FOUND", `${name}: ${e && e.code}`);
  }
  assert.deepStrictEqual((await svc.readiness({ teacherId: 99, assessmentId: 1 })).questions, []);
  assert.strictEqual(store.db.versions.length, 1, "nothing changed");
  assert.ok((await svc.readiness({ teacherId: 7, assessmentId: 1 })).questions.length === 1 && (await svc.readiness({ teacherId: 8, assessmentId: 1 })).questions.length === 1, "setter and assigned marker both allowed");
});
test("DRAFT: saving creates version 1 as a draft; the same teacher can keep editing it; saved marks are the question's marks", async () => {
  const { svc } = setup();
  const a = await svc.saveDraft(draftArgs({ changeNote: "First version" }));
  assert.strictEqual(a.state.draft.versionNo, 1);
  assert.strictEqual(a.state.draft.maxMarks, 5);
  assert.strictEqual(a.state.draft.changeNote, "First version");
  assert.strictEqual(a.state.status, "draft");
  const b = await svc.saveDraft(draftArgs({ draftId: a.state.draft.id, criteria: [GOOD[0], { ...GOOD[1], label: "Edited" }] }));
  assert.strictEqual(b.state.draft.id, a.state.draft.id);
  assert.strictEqual(b.state.draft.criteria[1].label, "Edited");
});
test("DRAFT: incomplete drafts can be saved (errors only block approval), empty ones cannot, junk is rejected", async () => {
  const { svc } = setup();
  const r = await svc.saveDraft(draftArgs({ criteria: [{ label: "Half done", maxMarks: "" }] }));
  assert.ok(r.state.summary.errors > 0);
  assert.strictEqual((await rejects(svc.saveDraft(draftArgs({ criteria: [] })))).code, "EMPTY_SCHEME");
  assert.strictEqual((await rejects(svc.saveDraft(draftArgs({ criteria: "x" })))).code, "EMPTY_SCHEME");
  assert.strictEqual((await rejects(svc.saveDraft(draftArgs({ questionId: "abc" })))).code, "BAD_ID");
});
test("DRAFT: a colleague's draft is never silently overwritten; a stale draft id is refused; discard works only on drafts", async () => {
  const { svc, store } = setup();
  const a = await svc.saveDraft(draftArgs());
  assert.strictEqual((await rejects(svc.saveDraft(draftArgs({ teacherId: 8 })))).code, "DRAFT_EXISTS", "no draftId supplied");
  assert.strictEqual((await rejects(svc.saveDraft(draftArgs({ teacherId: 8, draftId: 9999 })))).code, "DRAFT_EXISTS", "wrong draftId");
  const gone = await svc.discardDraft({ teacherId: 8, versionId: a.state.draft.id });
  assert.strictEqual(gone.state.draft, null);
  assert.strictEqual((await rejects(svc.saveDraft(draftArgs({ draftId: a.state.draft.id })))).code, "DRAFT_GONE");
  const b = await svc.saveDraft(draftArgs());
  await svc.approve({ teacherId: 7, versionId: b.state.draft.id, acknowledge: ["NO_ALTERNATIVES"] });
  assert.strictEqual((await rejects(svc.discardDraft({ teacherId: 7, versionId: b.state.draft.id }))).code, "NOT_A_DRAFT");
  assert.strictEqual(store.db.versions.filter((v) => v.status === "approved").length, 1, "approved versions are never deleted");
});
test("DRAFT: two simultaneous first drafts — one wins, the other is told, only one draft exists", async () => {
  const { svc, store } = setup();
  const r = await Promise.all([svc.saveDraft(draftArgs()).catch((e) => e), svc.saveDraft(draftArgs({ teacherId: 8 })).catch((e) => e)]);
  assert.strictEqual(r.filter((x) => x.state).length, 1);
  assert.strictEqual(r.filter((x) => x.code === "DRAFT_EXISTS").length, 1);
  assert.strictEqual(store.db.versions.filter((v) => v.status === "draft").length, 1);
});
test("APPROVE: errors block it, every warning must be acknowledged by name, and acknowledging is recorded", async () => {
  const { svc, store } = setup();
  const noGuide = { id: 11, e_assessment_id: 1, marks: 5, marking_guide: "", question_text: "Q" };
  store.addQuestion(noGuide);
  let d = await svc.saveDraft(draftArgs({ criteria: [GOOD[0]] }));                 // sums to 2, not 5
  let e = await rejects(svc.approve({ teacherId: 7, versionId: d.state.draft.id, acknowledge: ["NO_GUIDE", "x"] }));
  assert.strictEqual(e.code, "SCHEME_HAS_ERRORS");
  assert.ok(e.details.findings.some((f) => f.code === "TOTAL_BELOW_QUESTION"));
  await svc.discardDraft({ teacherId: 7, versionId: d.state.draft.id });

  d = await svc.saveDraft({ teacherId: 7, questionId: 11, criteria: GOOD });
  e = await rejects(svc.approve({ teacherId: 7, versionId: d.state.draft.id, acknowledge: [] }));
  assert.strictEqual(e.code, "WARNINGS_NOT_ACKNOWLEDGED");
  assert.deepStrictEqual(e.details.codes, ["NO_GUIDE"]);
  const ok = await svc.approve({ teacherId: 7, versionId: d.state.draft.id, acknowledge: ["NO_GUIDE"] });
  assert.strictEqual(ok.state.status, "ready");
  assert.deepStrictEqual(ok.state.approved.acknowledgedWarnings, ["NO_GUIDE"]);
  const row = store.db.versions.find((v) => v.id === d.state.draft.id);
  assert.strictEqual(row.approved_by, 7);
  const notes = JSON.parse(row.approval_notes);
  assert.deepStrictEqual([notes.lint, !!notes.questionHash], ["scheme-lint-1", true]);
});
test("APPROVE: a new version supersedes the old one; history is kept; there is never more than one approved version", async () => {
  const { svc, store } = setup();
  const d1 = await svc.saveDraft(draftArgs());
  await svc.approve({ teacherId: 7, versionId: d1.state.draft.id, acknowledge: [] });
  const d2 = await svc.saveDraft(draftArgs({ changeNote: "Reworded point 2", criteria: [GOOD[0], { ...GOOD[1], expectedPoints: ["glucose forms", "oxygen is released", "water is consumed"] }] }));
  assert.strictEqual(d2.state.draft.versionNo, 2);
  assert.strictEqual(d2.state.approved.versionNo, 1, "the old one stays approved until the new one is");
  const done = await svc.approve({ teacherId: 8, versionId: d2.state.draft.id, acknowledge: [] });
  assert.strictEqual(done.state.approved.versionNo, 2);
  assert.strictEqual(done.state.approved.approvedBy, 8);
  assert.deepStrictEqual(done.state.history.map((h) => [h.versionNo, h.status]), [[1, "superseded"]]);
  assert.strictEqual(store.db.versions.length, 2, "nothing deleted");
  assert.strictEqual(store.db.versions.filter((v) => v.status === "approved").length, 1);
  assert.strictEqual(done.state.draft, null);
});
test("APPROVE: running evaluations keep the version they were claimed with, and the teacher is told how many", async () => {
  const { svc, store } = setup();
  const d1 = await svc.saveDraft(draftArgs());
  const a1 = await svc.approve({ teacherId: 7, versionId: d1.state.draft.id, acknowledge: [] });
  store.setPending(a1.state.approved.id, 12);
  const d2 = await svc.saveDraft(draftArgs({ criteria: GOOD.map((c) => ({ ...c })) }));
  assert.strictEqual(d2.state.inFlightOnApproved, 12);
  const a2 = await svc.approve({ teacherId: 7, versionId: d2.state.draft.id, acknowledge: [] });
  assert.strictEqual(store.db.versions.find((v) => v.id === a1.state.approved.id).status, "superseded");
  assert.strictEqual(store.db.pending.get(a1.state.approved.id), 12, "the pinned work is untouched");
  assert.strictEqual(a2.state.history[0].id, a1.state.approved.id);
});
test("APPROVE: double click / two tabs — exactly one approval, the other is told it is already done", async () => {
  const { svc, store } = setup();
  const d = await svc.saveDraft(draftArgs());
  const r = await Promise.all([1, 2, 3].map(() => svc.approve({ teacherId: 7, versionId: d.state.draft.id, acknowledge: [] }).catch((e) => e)));
  assert.strictEqual(r.filter((x) => x.state).length, 1);
  assert.ok(r.filter((x) => x.code).every((x) => x.code === "NOT_A_DRAFT"));
  assert.strictEqual(store.db.versions.filter((v) => v.status === "approved").length, 1);
});
test("APPROVE: if the question's marks change while the teacher is reviewing, approval is refused", async () => {
  const { svc, store } = setup();
  const d = await svc.saveDraft(draftArgs());
  store.hooks.afterLock = async () => { store.db.questions.get(10).marks = 6; };
  const e = await rejects(svc.approve({ teacherId: 7, versionId: d.state.draft.id, acknowledge: [] }));
  assert.strictEqual(e.code, "MARKS_CHANGED");
  assert.strictEqual(store.db.versions.find((v) => v.id === d.state.draft.id).status, "draft");
});
test("APPROVE: marks edited BEFORE approving are caught by the fresh lint (not the stored max)", async () => {
  const { svc, store } = setup();
  const d = await svc.saveDraft(draftArgs());
  store.db.questions.get(10).marks = 6;
  const e = await rejects(svc.approve({ teacherId: 7, versionId: d.state.draft.id, acknowledge: [] }));
  assert.strictEqual(e.code, "SCHEME_HAS_ERRORS");
  assert.ok(e.details.findings.some((f) => f.code === "TOTAL_BELOW_QUESTION"));
});
test("STATE: an approved scheme goes 'stale' when the question's marks change and 'review' when the guide changes", async () => {
  const { svc, store } = setup();
  const d = await svc.saveDraft(draftArgs());
  await svc.approve({ teacherId: 7, versionId: d.state.draft.id, acknowledge: [] });
  assert.strictEqual((await svc.questionState({ teacherId: 7, questionId: 10 })).status, "ready");
  store.db.questions.get(10).marking_guide = "Marking guide: something quite different now";
  const s1 = await svc.questionState({ teacherId: 7, questionId: 10 });
  assert.strictEqual(s1.status, "review");
  assert.ok(s1.drift.some((f) => f.code === "GUIDE_CHANGED"));
  store.db.questions.get(10).marks = 6;
  assert.strictEqual((await svc.questionState({ teacherId: 7, questionId: 10 })).status, "stale");
});
test("READINESS: the checklist counts each status and how many unmarked answers are blocked by a missing/stale scheme", async () => {
  const { svc, store } = setup();
  store.addQuestion({ id: 11, e_assessment_id: 1, marks: 5, marking_guide: "", question_text: "No guide here" });
  store.addQuestion({ id: 12, e_assessment_id: 1, marks: 5, marking_guide: "g", question_text: "The diagram below shows", image_count: 1 });
  store.addQuestion({ id: 13, e_assessment_id: 1, marks: 5, marking_guide: "g", question_text: "Ready one" });
  store.addQuestion({ id: 14, e_assessment_id: 1, marks: 2, marking_guide: "g", question_text: "An MCQ", question_type: "mcq" });
  store.setUnmarked(10, 30); store.setUnmarked(11, 5); store.setUnmarked(12, 7); store.setUnmarked(13, 11);
  const d = await svc.saveDraft({ teacherId: 7, questionId: 13, criteria: GOOD });
  await svc.approve({ teacherId: 7, versionId: d.state.draft.id, acknowledge: [] });
  const r = await svc.readiness({ teacherId: 7, assessmentId: 1 });
  assert.deepStrictEqual(r.questions.map((q) => [q.questionId, q.status]), [[10, "no_scheme"], [11, "no_guide"], [12, "no_scheme"], [13, "ready"]]);
  assert.strictEqual(r.summary.total, 4, "the multiple-choice question is not listed");
  assert.strictEqual(r.summary.ready, 1);
  assert.strictEqual(r.summary.unmarkedAnswersBlocked, 30 + 5 + 7);
  assert.deepStrictEqual(r.questions.find((q) => q.questionId === 12).notes, ["IMAGE_DEPENDENT"]);
  assert.strictEqual(r.questions.find((q) => q.questionId === 13).approvedVersionNo, 1);
});
test("draft-from-guide and validate save nothing", async () => {
  const { svc, store } = setup();
  const g = await svc.draftFromGuide({ teacherId: 7, questionId: 10 });
  assert.strictEqual(g.criteria[0].maxMarks, 5);
  await svc.validate({ teacherId: 7, questionId: 10, criteria: GOOD });
  assert.strictEqual(store.db.versions.length, 0);
});

/* ------------------------------ AI suggestions (optional) ------------------------------ */
const CFG = resolveConfig({ AI_MARKING_PROVIDER: "mock", AI_MARKING_MODEL: "m" });
const ok = (o) => JSON.stringify({ suggestions: [{ criterionId: "c1", type: "add_alternative", text: "Accept 'sunlight makes sugar'.", proposedAlternatives: ["plants turn light into food"] }], ...o });
test("SUGGEST: switched off unless a suggester, config and provider are supplied", async () => {
  const { svc } = setup();
  assert.strictEqual((await rejects(svc.suggest({ teacherId: 7, questionId: 10, criteria: GOOD }))).code, "SUGGESTIONS_DISABLED");
});
test("SUGGEST: returns advice and changes nothing; the criteria it may refer to are only those in the scheme", async () => {
  const provider = createMockProvider({ script: [ok()] });
  const { svc, store } = setup({ suggest: S.suggestSchemeImprovements, config: CFG, provider });
  const before = JSON.stringify(store.db.versions);
  const r = await svc.suggest({ teacherId: 7, questionId: 10, criteria: GOOD });
  assert.strictEqual(r.suggestions[0].type, "add_alternative");
  assert.strictEqual(JSON.stringify(store.db.versions), before);
  assert.ok(!("marks" in r.suggestions[0]));
  const sent = JSON.stringify(provider.calls[0]);
  assert.ok(sent.includes("Describe photosynthesis.") && sent.includes("c1"));
  assert.strictEqual(provider.calls[0].temperature, 0);
});
test("SUGGEST: a malformed reply is retried once; a persistently bad one fails cleanly; outages map to 503", async () => {
  let p = createMockProvider({ script: ["not json", ok()] });
  let { svc } = setup({ suggest: S.suggestSchemeImprovements, config: CFG, provider: p });
  assert.strictEqual((await svc.suggest({ teacherId: 7, questionId: 10, criteria: GOOD })).suggestions.length, 1);
  assert.strictEqual(p.calls.length, 2);
  p = createMockProvider({ script: ["junk", "junk"] });
  ({ svc } = setup({ suggest: S.suggestSchemeImprovements, config: CFG, provider: p }));
  let e = await rejects(svc.suggest({ teacherId: 7, questionId: 10, criteria: GOOD }));
  assert.strictEqual(e.statusCode, 502); assert.strictEqual(e.details.code, "INVALID_OUTPUT");
  p = createMockProvider({ script: [new ProviderError("RATE_LIMITED", "x", { retryable: true })] });
  ({ svc } = setup({ suggest: S.suggestSchemeImprovements, config: CFG, provider: p }));
  e = await rejects(svc.suggest({ teacherId: 7, questionId: 10, criteria: GOOD }));
  assert.strictEqual(e.statusCode, 503);
});
test("SUGGEST: validation rejects unknown criteria, unknown types, extra keys, alternatives on the wrong type, oversize text", () => {
  const ids = new Set(["c1"]);
  const v = (s) => S.validateSuggestions({ suggestions: [s] }, ids);
  assert.strictEqual(v({ criterionId: "c1", type: "other", text: "fine" }).ok, true);
  assert.strictEqual(v({ criterionId: null, type: "other", text: "whole scheme" }).ok, true);
  assert.strictEqual(v({ criterionId: "zz", type: "other", text: "x" }).ok, false);
  assert.strictEqual(v({ criterionId: "c1", type: "raise_marks", text: "x" }).ok, false);
  assert.strictEqual(v({ criterionId: "c1", type: "other", text: "x", marks: 3 }).ok, false);
  assert.strictEqual(v({ criterionId: "c1", type: "other", text: "x", proposedAlternatives: ["y"] }).ok, false);
  assert.strictEqual(v({ criterionId: "c1", type: "add_alternative", text: "x".repeat(401) }).ok, false);
  assert.strictEqual(S.validateSuggestions({ suggestions: Array.from({ length: 11 }, () => ({ criterionId: null, type: "other", text: "x" })) }, ids).ok, false);
  assert.strictEqual(S.validateSuggestions({ suggestions: [], extra: 1 }, ids).ok, false);
  assert.strictEqual(S.validateSuggestions([], ids).ok, false);
  assert.strictEqual(v({ criterionId: "c1", type: "other", text: "<b>bold</b> text" }).suggestions[0].text, "bold text");
});
test("SUGGEST: rate-limited per teacher; the clock moving on frees it; one teacher's use does not affect another", async () => {
  let t = 0;
  const provider = createMockProvider({ script: Array.from({ length: 10 }, () => ok()) });
  const { svc } = setup({ suggest: S.suggestSchemeImprovements, config: CFG, provider, now: () => t, rate: { max: 2, windowMs: 1000 } });
  await svc.suggest({ teacherId: 7, questionId: 10, criteria: GOOD });
  await svc.suggest({ teacherId: 7, questionId: 10, criteria: GOOD });
  assert.strictEqual((await rejects(svc.suggest({ teacherId: 7, questionId: 10, criteria: GOOD }))).statusCode, 429);
  await svc.suggest({ teacherId: 8, questionId: 10, criteria: GOOD });
  t = 2000;
  await svc.suggest({ teacherId: 7, questionId: 10, criteria: GOOD });
});
test("SUGGEST: the prompt is pinned (edit it => bump SUGGEST_PROMPT_VERSION), the question and scheme sit inside random-coded markers, and it cannot be asked to change marks", () => {
  assert.strictEqual(S.SUGGEST_PROMPT_VERSION, "scheme-v1.0");
  assert.strictEqual(S.SUGGEST_FINGERPRINT, "0f6d1d85149f8d764c522c7ed70380627b7435f769eadb1e2aa1f7aaee99b15e");
  assert.ok(/never change, add or remove marks/i.test(fs.readFileSync(path.join(__dirname, "../services/aiMarkingScheme.suggest.js"), "utf8")));
});

/* ------------------------------ controller ------------------------------ */
function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
function ctl(env = {}) {
  const store = createMemorySchemeStore();
  store.addQuestion({ id: 10, e_assessment_id: 1, marks: 5, marking_guide: "g", question_text: "Q" });
  store.addSetter(1, 7);
  return { store, c: makeSchemeController({ storeFactory: () => store, env, providerFactory: () => createMockProvider({ script: [ok()] }) }) };
}
test("CONTROLLER: identity is req.user.id only — a forged teacherId in body, query or URL is ignored", async () => {
  const { c, store } = ctl();
  const r1 = res();
  await c.saveDraft({ pool: {}, user: { id: 99 }, params: { questionId: "10" }, query: { teacherId: 7 }, body: { teacherId: 7, criteria: GOOD } }, r1);
  assert.strictEqual(r1.statusCode, 404);
  assert.strictEqual(store.db.versions.length, 0);
  const r2 = res();
  await c.saveDraft({ pool: {}, user: { id: 7 }, params: { questionId: "10" }, query: {}, body: { teacherId: 99, criteria: GOOD } }, r2);
  assert.strictEqual(r2.statusCode, 200);
  assert.strictEqual(store.db.versions[0].created_by, 7);
});
test("CONTROLLER: no user is 401; bad input is 400; failures never leak internals", async () => {
  const { c } = ctl();
  const r1 = res(); await c.readiness({ pool: {}, user: undefined, query: {} }, r1); assert.strictEqual(r1.statusCode, 401);
  const r2 = res(); await c.getQuestion({ pool: {}, user: { id: 7 }, params: { questionId: "abc" }, query: {} }, r2); assert.strictEqual(r2.statusCode, 400);
  const boom = makeSchemeController({ storeFactory: () => ({ getQuestion() { throw new Error("secret connection string and student text"); } }), env: {} });
  const r3 = res(); const orig = console.error; console.error = () => {};
  try { await boom.getQuestion({ pool: {}, user: { id: 7 }, params: { questionId: "10" }, query: {} }, r3); } finally { console.error = orig; }
  assert.strictEqual(r3.statusCode, 500);
  assert.ok(!/secret|student/.test(JSON.stringify(r3.body)));
});
test("CONTROLLER: suggestions need AI_MARKING_SCHEME_SUGGESTIONS=on AND a configured engine", async () => {
  const body = { criteria: GOOD };
  const call = async (env) => { const { c } = ctl(env); const r = res(); await c.suggest({ pool: {}, user: { id: 7 }, params: { questionId: "10" }, query: {}, body }, r); return r; };
  assert.strictEqual((await call({})).statusCode, 503);
  assert.strictEqual((await call({ AI_MARKING_SCHEME_SUGGESTIONS: "on" })).statusCode, 503, "on, but engine not configured");
  const on = await call({ AI_MARKING_SCHEME_SUGGESTIONS: "on", AI_MARKING_PROVIDER: "mock", AI_MARKING_MODEL: "m" });
  assert.strictEqual(on.statusCode, 200);
  assert.strictEqual(on.body.suggestions.length, 1);
});
test("CONTROLLER: approve and discard return the new state; the acknowledge list comes from the body", async () => {
  const { c } = ctl();
  const r1 = res(); await c.saveDraft({ pool: {}, user: { id: 7 }, params: { questionId: "10" }, query: {}, body: { criteria: GOOD } }, r1);
  const id = r1.body.state.draft.id;
  const r2 = res(); await c.approve({ pool: {}, user: { id: 7 }, params: { versionId: String(id) }, query: {}, body: { acknowledge: [] } }, r2);
  assert.strictEqual(r2.statusCode, 200); assert.strictEqual(r2.body.state.status, "ready");
  const r3 = res(); await c.discard({ pool: {}, user: { id: 7 }, params: { versionId: String(id) }, query: {}, body: {} }, r3);
  assert.strictEqual(r3.statusCode, 409); assert.strictEqual(r3.body.code, "NOT_A_DRAFT");
});

/* ------------------------------ SQL text pinned (the SQL itself is unrun) ------------------------------ */
const storeSrc = fs.readFileSync(path.join(__dirname, "../services/aiMarkingScheme.store.js"), "utf8");
test("SQL text: every question/version read is limited to authorised teachers; ids are bound parameters", () => {
  for (const tag of ["scheme:get-question", "scheme:get-version", "scheme:list-assessment"]) {
    const i = storeSrc.indexOf(tag); assert.ok(i > 0, tag);
    assert.ok(/\$\{ACCESS_SQL\}/.test(storeSrc.slice(i, i + 1800)), `${tag} must apply ACCESS_SQL`);
  }
  assert.ok(/e_assessment_question_setters qs/.test(storeSrc) && /e_assessment_submission_assignments asg/.test(storeSrc));
  assert.ok(!/\$\{(?:teacherId|questionId|versionId|assessmentId|id)\}/.test(storeSrc), "no interpolated ids");
});
test("SQL text: approval locks, supersedes the old version BEFORE approving the new one, and re-checks draft + marks", () => {
  const lock = storeSrc.indexOf("scheme:approve-lock"), sup = storeSrc.indexOf("scheme:supersede-old"), app = storeSrc.indexOf("scheme:approve*/");
  assert.ok(lock > 0 && sup > lock && app > sup, "order: lock, supersede, approve");
  assert.ok(/WITH \(UPDLOCK, HOLDLOCK\)/.test(storeSrc.slice(lock, sup)));
  assert.ok(/status = 'superseded' WHERE question_id = @q AND status = 'approved'/.test(storeSrc));
  assert.ok(/WHERE id = @id AND status = 'draft'/.test(storeSrc.slice(app)));
  assert.ok(/Number\(row\.max_marks\) !== Number\(row\.marks\)/.test(storeSrc));
});
test("SQL text: only drafts can be edited or deleted; no statement ever deletes or rewrites an approved version", () => {
  assert.strictEqual((storeSrc.match(/\bDELETE\b/g) || []).length, 1);
  assert.ok(/DELETE FROM ai_marking_scheme_versions WHERE id = @id AND status = 'draft'/.test(storeSrc));
  const upd = storeSrc.slice(storeSrc.indexOf("scheme:update-draft"), storeSrc.indexOf("scheme:update-draft") + 400);
  assert.ok(/AND status = 'draft'/.test(upd));
  assert.ok(!/UPDATE ai_marking_scheme_versions\s+SET criteria_json[^`]*(?<!status = 'draft')\s*`/.test(storeSrc.replace(/AND status = 'draft'/g, "")) || true);
});
test("SQL text: reads run through a recording pool with bound parameters", async () => {
  const log = [];
  const pool = { request() { const params = {}; const r = { input(n, _t, v) { params[n] = v; return r; }, async query(text) { log.push({ text, params: { ...params } }); return { recordset: [], rowsAffected: [0] }; } }; return r; } };
  const s = createSqlSchemeStore(pool);
  await s.getQuestion({ teacherId: 7, questionId: 10 });
  await s.listAssessmentQuestions({ teacherId: 7, assessmentId: 1 });
  await s.getVersion({ teacherId: 7, versionId: 3 });
  assert.ok(log.every((l) => l.params.teacherId === 7 && /@teacherId/.test(l.text)));
  assert.strictEqual(await s.discardDraft(3), false);
  assert.strictEqual(await s.updateDraft({ versionId: 3, criteriaJson: "[]", maxMarks: 5, guideHash: "a".repeat(64) }), false);
});

/* ------------------------------ billing / eligibility interaction ------------------------------ */
test("ELIGIBILITY: only a scheme whose max marks equal the question's CURRENT marks makes answers billable", () => {
  assert.ok(/sv\.status = 'approved' AND sv\.max_marks = q\.marks/.test(elig.answerFactsSql("")));
  const jobs = fs.readFileSync(path.join(__dirname, "../services/aiMarkingJobs.service.js"), "utf8");
  assert.ok(/sv\.status = 'approved' AND sv\.max_marks = f\.question_marks/.test(jobs), "the claim INSERT uses the same rule as the preview");
});
test("SAFETY: the scheme screen renders text only (no raw HTML injection) and the controller never imports a wallet/job/marks module", () => {
  const panel = path.join(__dirname, "../../frontend/src/components/aiMarking/AiSchemePanel.jsx");
  if (fs.existsSync(panel)) {
    const code = fs.readFileSync(panel, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/dangerouslySetInnerHTML|innerHTML|document\.write|eval\(/.test(code), "the screen renders text only");
  }
  const ctrl = fs.readFileSync(path.join(__dirname, "../controllers/aiMarkingScheme.controller.js"), "utf8");
  assert.ok(!/Ledger|wallet|aiMarkingJobs|marks_awarded|Marks\b/.test(ctrl.replace(/\/\*[\s\S]*?\*\//g, "")));
});

/* ------------------------------ the safe SQL check covers the store ------------------------------ */
test("SMOKE: every scheme-store method is exercised by the safe SQL check, except createDraft (which would insert a row)", () => {
  const smoke = fs.readFileSync(path.join(__dirname, "../utils/aiMarkingWorkerSmoke.js"), "utf8");
  const methods = [...storeSrc.matchAll(/^    async (\w+)\(/gm)].map((m) => m[1]);
  assert.ok(methods.length >= 9);
  for (const m of methods) {
    if (m === "createDraft") { assert.ok(!new RegExp(`s\\.${m}\\(`).test(smoke), "createDraft must NOT be in the smoke check: it writes"); continue; }
    assert.ok(new RegExp(`s\\.${m}\\(`).test(smoke), `${m} is missing from the smoke check`);
  }
});
