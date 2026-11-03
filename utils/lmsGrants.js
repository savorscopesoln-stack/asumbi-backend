/* =========================================================================
   LMS PERMISSION GRANTS  (L1.4, decision D-003/D-010)
   Lets an LMS administrator give extra LMS permissions (e.g. HOD:
   lms.course.approve) to a teacher or staff user. Students and platform
   roles can never be granted anything. Replace-style: the submitted list
   becomes that user's full grant set.
========================================================================= */
const sql = require("mssql");
const { PERMISSIONS } = require("./lmsPermissions");
const { audit } = require("./lmsAudit");

const GRANTABLE_SOURCES = { Teachers: "Teachers", Users: "Users" }; // whitelist -> table name (never interpolate client input)

function validateGrant({ userSource, userId, permissionCodes } = {}) {
  const errors = [];
  if (!Object.prototype.hasOwnProperty.call(GRANTABLE_SOURCES, userSource)) errors.push("userSource must be Teachers or Users.");
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) errors.push("userId must be a positive integer.");
  if (!Array.isArray(permissionCodes)) errors.push("permissionCodes must be a list.");
  else {
    const bad = permissionCodes.filter((c) => !PERMISSIONS.includes(c));
    if (bad.length) errors.push(`Unknown permission code(s): ${bad.join(", ")}.`);
  }
  return { ok: errors.length === 0, errors, id, codes: errors.length ? [] : [...new Set(permissionCodes)] };
}

async function listGrants(pool, { userSource, userId } = {}) {
  const v = validateGrant({ userSource, userId, permissionCodes: [] });
  if (!v.ok) return { ok: false, errors: v.errors };
  const r = await pool.request().input("s", sql.NVarChar(20), userSource).input("u", sql.Int, v.id)
    .query(`SELECT permission_code FROM lms_user_permissions WHERE user_source = @s AND user_id = @u ORDER BY permission_code`);
  return { ok: true, permissionCodes: r.recordset.map((x) => x.permission_code) };
}

async function setGrants(pool, actor, input) {
  const v = validateGrant(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  const table = GRANTABLE_SOURCES[input.userSource];
  const exists = await pool.request().input("u", sql.Int, v.id).query(`SELECT TOP 1 id FROM ${table} WHERE id = @u`);
  if (!exists.recordset || !exists.recordset.length) return { ok: false, notFound: true, errors: ["That user was not found."] };
  await pool.request().input("s", sql.NVarChar(20), input.userSource).input("u", sql.Int, v.id)
    .query(`DELETE FROM lms_user_permissions WHERE user_source = @s AND user_id = @u`);
  for (const code of v.codes) {
    await pool.request().input("s", sql.NVarChar(20), input.userSource).input("u", sql.Int, v.id)
      .input("c", sql.NVarChar(60), code).input("g", sql.Int, actor?.id ?? null)
      .query(`INSERT INTO lms_user_permissions (user_source, user_id, permission_code, granted_by) VALUES (@s, @u, @c, @g)`);
  }
  await audit(pool, actor, "permissions.set", "lms_user_permissions", `${input.userSource}:${v.id}`, { codes: v.codes });
  return { ok: true, permissionCodes: v.codes };
}

module.exports = { validateGrant, listGrants, setGrants };
