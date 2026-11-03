/* L6.1b - question CSV. PURE: no pool. Round trips with hostile text, formula protection, every per-type parse error. */
const { suite, test, assert } = require("./helpers/tinytest");
suite("lmsQuestionCsv.test.js");
const C = require("../utils/lmsQuestionCsv");
const { readCsv } = require("../utils/lmsCsv");
const M = require("../utils/lmsQuizMarking");

const mk = (body) => { const v = M.validateQuestion({ stem: "Q", ...body }); assert.ok(v.ok, JSON.stringify(v.errors)); return { ...v.value, ...v.value.spec ? {} : {} }; };
const back = (questions) => {
  const parsed = readCsv(C.toCsv(questions), { required: C.REQUIRED, known: C.KNOWN }); assert.ok(parsed.ok, JSON.stringify(parsed.errors));
  return C.rowsToBodies(parsed.rows).map((r) => { assert.ok(r.body, JSON.stringify(r.errors)); const v = M.validateQuestion(r.body); assert.ok(v.ok, JSON.stringify(v.errors)); return v.value; });
};

test("round trip: every type survives export then import, including text full of separators, quotes, commas, newlines and a leading ' or *", () => {
  const nasty = ['a|b', 'x*y', '~tilde~', 'back\\slash', 'com,ma', 'say "hi"', '*star', "'quoted", " "].map((t) => (t.trim() ? t : "plain"));
  const qs = [
    mk({ type: "mcq_single", stem: "Pick, one\nsecond line", explanation: "Because, \"reasons\"\nmore", points: 2.5, difficulty: "hard", subject: "Bio, 1", topic: "Cells", options: [{ text: nasty[0], correct: true }, { text: nasty[1] }, { text: nasty[7] }, { text: nasty[5] }] }),
    mk({ type: "mcq_multi", partialCredit: true, options: [{ text: nasty[6], correct: true }, { text: nasty[3], correct: true }, { text: nasty[2] }, { text: nasty[4] }] }),
    mk({ type: "true_false", correct: false, stem: "'=still a stem" }),
    mk({ type: "short_answer", accepted: [nasty[0], nasty[1], "Nairobi"], caseSensitive: true }),
    mk({ type: "numeric", value: -9.81, tolerance: 0.5, unit: "m/s" }), mk({ type: "numeric", value: 3 }),
    mk({ type: "matching", partialCredit: true, pairs: [{ left: nasty[0], right: nasty[1] }, { left: nasty[2], right: nasty[3] }, { left: "plain", right: "other" }] }),
    mk({ type: "ordering", items: [nasty[0], nasty[1], nasty[2], nasty[3]], partialCredit: true }),
    mk({ type: "essay", maxWords: 300, stem: "Discuss." }), mk({ type: "essay" }),
  ];
  const out = back(qs);
  assert.strictEqual(out.length, qs.length);
  qs.forEach((q, i) => { for (const k of ["type", "stem", "explanation", "points", "difficulty", "subject", "topic"]) assert.deepStrictEqual(out[i][k], q[k], `question ${i} ${k}`); assert.deepStrictEqual(out[i].spec, q.spec, `question ${i} spec`); });
});

test("export: header, BOM, and spreadsheet formulas are neutralised (= + - @ tab CR) in EVERY text cell", () => {
  const evil = ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"];
  const q = mk({ type: "short_answer", stem: evil[0], explanation: evil[2], subject: evil[3], topic: evil[1], accepted: ["=cmd", "ok"] });
  const csv = C.toCsv([q]); assert.ok(csv.startsWith("﻿type,stem,points,difficulty,subject,topic,explanation,answer,partialCredit,caseSensitive,maxWords,unit\n"));
  const rows = readCsv(csv, { required: C.REQUIRED }).rows; const cells = rows[0].cells;
  for (const k of ["stem", "subject", "topic", "explanation", "answer"]) assert.ok(cells[k].startsWith("'"), `${k} cell is guarded: ${cells[k]}`);
  assert.ok(!/^[=+\-@\t\r]/.test(cells.stem) && !/^[=+\-@\t\r]/.test(cells.answer));
  assert.strictEqual(back([q])[0].stem, q.stem, "the importer removes the guard again");
  const negative = mk({ type: "numeric", value: -5, tolerance: 1 }); assert.ok(readCsv(C.toCsv([negative]), { required: C.REQUIRED }).rows[0].cells.answer.startsWith("'-5"));
  assert.deepStrictEqual(back([negative])[0].spec.value, -5);
  assert.strictEqual(C.toCsv([]).trim(), "﻿type,stem,points,difficulty,subject,topic,explanation,answer,partialCredit,caseSensitive,maxWords,unit".trim());
});

test("import: per-type answer parsing and its error messages", () => {
  const p = C.parseAnswer;
  assert.deepStrictEqual(p("mcq_single", "*A|B|C").fields.options, [{ text: "A", correct: true }, { text: "B", correct: false }, { text: "C", correct: false }]);
  assert.deepStrictEqual(p("mcq_multi", "*A|*B|C").fields.options.map((o) => o.correct), [true, true, false]);
  assert.deepStrictEqual(p("mcq_single", "\\*A|B").fields.options, [{ text: "*A", correct: false }, { text: "B", correct: false }], "an escaped * is text, not a correct marker");
  assert.deepStrictEqual(p("mcq_single", "A\\|B|*C").fields.options.map((o) => o.text), ["A|B", "C"]);
  assert.deepStrictEqual([p("true_false", " TRUE ").fields, p("true_false", "false").fields], [{ correct: true }, { correct: false }]);
  assert.ok(p("true_false", "yes").error && p("true_false", "").error);
  assert.deepStrictEqual(p("short_answer", "a|b\\|c").fields.accepted, ["a", "b|c"]);
  assert.deepStrictEqual([p("numeric", "9.81").fields, p("numeric", "9.81~0.01").fields, p("numeric", "9.81~").fields], [{ value: "9.81" }, { value: "9.81", tolerance: "0.01" }, { value: "9.81" }]);
  assert.ok(p("numeric", "1~2~3").error && p("numeric", "").error);
  assert.deepStrictEqual(p("matching", "a=>1|b=>2").fields.pairs, [{ left: "a", right: "1" }, { left: "b", right: "2" }]);
  assert.ok(p("matching", "a=>1|nopair").error && p("matching", "").error);
  assert.deepStrictEqual(p("ordering", "x|y|z").fields.items, ["x", "y", "z"]);
  assert.ok(p("mcq_single", "").error && p("short_answer", "  ").error && p("ordering", "").error);
  assert.deepStrictEqual(p("essay", "").fields, {}); assert.ok(p("essay", "something").error); assert.ok(p("weird", "x").error);
});

test("import: rowsToBodies reads optional columns, ignores blanks, keeps wrong-type extras so validation rejects them, and reports parse errors per line", () => {
  const csv = "Type,Stem,Points,Difficulty,Partial Credit,Answer\nmcq_multi,Q1,2,easy,true,*A|*B|C\nessay,Q2,,,,\ntrue_false,Q3,,,true,true\nmatching,Q4,,,,oops\n";
  const parsed = readCsv(csv, { required: C.REQUIRED, known: C.KNOWN }); assert.ok(parsed.ok, JSON.stringify(parsed.errors));
  const r = C.rowsToBodies(parsed.rows);
  assert.deepStrictEqual([r[0].line, r[0].body.points, r[0].body.difficulty, r[0].body.partialCredit], [2, "2", "easy", "true"]);
  assert.ok(M.validateQuestion(r[0].body).ok); assert.ok(!("points" in r[1].body) && !("difficulty" in r[1].body), "blank cells are left out so defaults apply");
  assert.ok(M.validateQuestion(r[1].body).ok);
  assert.strictEqual(M.validateQuestion(r[2].body).ok, false, "partialCredit on a true/false question is refused by validation");
  assert.deepStrictEqual([r[3].line, typeof r[3].errors[0]], [5, "string"]); assert.ok(!r[3].body);
  assert.deepStrictEqual(C.rowsToBodies(null), []);
});

test("import: unknown column, missing required column and over-size files are refused by the reader", () => {
  assert.strictEqual(readCsv("type,stem,color\nessay,Q,red\n", { required: C.REQUIRED, known: C.KNOWN }).code, "CSV_UNKNOWN_COLUMN");
  assert.strictEqual(readCsv("type,answer\nessay,\n", { required: C.REQUIRED, known: C.KNOWN }).code, "CSV_NO_HEADER");
  assert.strictEqual(readCsv("type,stem\n" + "essay,Q\n".repeat(151), { required: C.REQUIRED, known: C.KNOWN, maxRows: 150 }).code, "CSV_TOO_MANY_ROWS");
  assert.strictEqual(readCsv("type,stem\n" + "essay," + "x".repeat(300 * 1024) + "\n", { required: C.REQUIRED, known: C.KNOWN, maxBytes: 256 * 1024 }).code, "CSV_TOO_LARGE");
});
