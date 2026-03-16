import { json, parseBody, requireAdmin, uid, getJson, putJson } from "./utils.js";
import { normalizeCourseRecord, validateCourse } from "./course_data.js";
import { importBlueGolfCourse } from "./bluegolf_import.js";

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
      const bluegolfUrl = String(
        body?.bluegolfUrl
          ?? body?.importBlueGolf?.url
          ?? body?.course?.bluegolfUrl
          ?? ""
      ).trim();

      let importedMetadata = null;
      let course = body?.course || body || {};
      if (bluegolfUrl) {
        const imported = await importBlueGolfCourse(bluegolfUrl);
        importedMetadata = imported.metadata || null;
        course = {
          ...imported.course,
          ...(course && typeof course === "object" ? course : {})
        };
      }

      const errMsg = validateCourse(course);
      if (errMsg) return json(400, { error: errMsg });
      const normalizedCourse = normalizeCourseRecord(course);
      if (!normalizedCourse) return json(400, { error: "Invalid course payload." });

      const now = Date.now();
      const givenId = String(course.courseId || body?.courseId || "").trim();
      const importedId = importedMetadata?.bluegolfCourseSlug
        ? `bluegolf-${importedMetadata.bluegolfCourseSlug}`
        : "";
      const courseId = givenId || importedId || uid("c");

      const next = await updateCatalogWithRetry((current) => {
        current.courses = current.courses || {};
        const prev = current.courses[courseId] || {};
        current.courses[courseId] = {
          ...prev,
          ...normalizedCourse,
          courseId,
          createdAt: prev.createdAt || now,
          updatedAt: now
        };
        current.updatedAt = now;
        current.version = Number(current.version || 0) + 1;
        return current;
      });

      return json(200, {
        ok:true,
        imported: !!importedMetadata,
        ...(importedMetadata ? { importMetadata: importedMetadata } : {}),
        course: next.courses[courseId]
      });
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
