import { json, parseBody, requireAdmin, uid, getJson, putJson } from "./utils.js";

function validateCourse(course){
  const pars = course?.pars;
  const strokeIndex = course?.strokeIndex;
  if (!Array.isArray(pars) || pars.length !== 18) return "course.pars must be an array of length 18";
  if (!Array.isArray(strokeIndex) || strokeIndex.length !== 18) return "course.strokeIndex must be an array of length 18";
  for (const p of pars){
    if (!Number.isFinite(Number(p))) return "All pars must be numbers";
  }
  const si = strokeIndex.map(Number);
  const set = new Set(si);
  if (set.size !== 18) return "Stroke Index must contain 18 unique values";
  for (const v of si){
    if (!Number.isInteger(v) || v < 1 || v > 18) return "Stroke Index values must be integers 1..18";
  }
  return null;
}

async function updateCatalogWithRetry(updater, { maxTries=5 } = {}){
  const bucket = process.env.STATE_BUCKET;
  const key = "courses/catalog.json";

  for (let attempt=1; attempt<=maxTries; attempt++){
    const { json: current, etag } = await getJson(bucket, key);
    const next = updater(current || { courses: {}, updatedAt: 0, version: 0 });
    try{
      await putJson(bucket, key, next, { ifMatch: etag, gzip:false, cacheControl:"no-store" });
      return next;
    }catch(e){
      const code = e?.$metadata?.httpStatusCode;
      if (code === 412 || e?.name === "PreconditionFailed"){
        if (attempt === maxTries){
          const err = new Error("Concurrent update conflict, please retry");
          err.statusCode = 409;
          throw err;
        }
        continue;
      }
      if (!etag && (code === 404 || e?.name === "NoSuchKey")){
        await putJson(bucket, key, next, { gzip:false, cacheControl:"no-store" });
        return next;
      }
      throw e;
    }
  }
  const err = new Error("Failed to update courses");
  err.statusCode = 500;
  throw err;
}

export async function handler(event){
  try{
    const method = String(event?.requestContext?.http?.method || event?.httpMethod || "").toUpperCase();
    const bucket = process.env.STATE_BUCKET;
    const key = "courses/catalog.json";

    if (method === "POST"){
      requireAdmin(event);
      const body = await parseBody(event);
      const course = body?.course || body || {};

      const errMsg = validateCourse(course);
      if (errMsg) return json(400, { error: errMsg });

      const now = Date.now();
      const givenId = String(course.courseId || "").trim();
      const courseId = givenId || uid("c");
      const name = String(course.name || "").trim() || "Course";

      const next = await updateCatalogWithRetry((current) => {
        current.courses = current.courses || {};
        const prev = current.courses[courseId] || {};
        current.courses[courseId] = {
          courseId,
          name,
          pars: course.pars.map(Number),
          strokeIndex: course.strokeIndex.map(Number),
          createdAt: prev.createdAt || now,
          updatedAt: now
        };
        current.updatedAt = now;
        current.version = Number(current.version || 0) + 1;
        return current;
      });

      return json(200, { ok:true, course: next.courses[courseId] });
    }

    if (method === "GET"){
      const { json: catalog } = await getJson(bucket, key);
      const courses = Object.values(catalog?.courses || {}).sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0));
      const courseId = String(event?.pathParameters?.courseId || "").trim();
      if (courseId){
        const found = catalog?.courses?.[courseId];
        if (!found) return json(404, { error: "course not found" });
        return json(200, found);
      }
      return json(200, { courses });
    }

    return json(405, { error: "Method not allowed" }, { Allow: "GET,POST,OPTIONS" });
  } catch(e){
    return json(e.statusCode || 500, { error: e.message || "Server error" });
  }
}
