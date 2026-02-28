import { json } from "./utils.js";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import zlib from "zlib";

const s3 = new S3Client({});

async function streamToBuffer(stream){
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c)=>chunks.push(Buffer.from(c)));
    stream.on("end", ()=>resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export async function handler(event){
  try{
    const code = event.pathParameters?.code;
    if (!code) return json(400, { error: "missing code" });

    const bucket = process.env.PUBLIC_BUCKET;
    const key = `enter/${code}.json`;

    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const buf = await streamToBuffer(r.Body);

    let outBuf = buf;
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b){
      outBuf = zlib.gunzipSync(buf);
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type":"application/json",
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Allow-Headers":"Content-Type,x-admin-key",
        "Access-Control-Allow-Methods":"GET,POST,OPTIONS"
      },
      body: outBuf.toString("utf-8")
    };
  } catch(e){
    const code = e?.$metadata?.httpStatusCode;
    if (code === 404) return json(404, { error: "invalid code" });
    return json(e.statusCode || 500, { error: e.message || "Server error" });
  }
}
