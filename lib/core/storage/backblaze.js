const {
  S3Client,GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  
require("../../config/env");
console.log("B2 ENV CHECK:", {
  endpoint: process.env.B2_ENDPOINT,
  bucketName: process.env.B2_BUCKET_NAME,
  keyId: process.env.B2_KEY_ID ? "ADA" : "KOSONG",
  appKey: process.env.B2_APPLICATION_KEY ? "ADA" : "KOSONG",
  publicUrl: process.env.B2_PUBLIC_URL,
});

function trimSlash(value) {
  return (value || "").toString().replace(/\/+$/, "");
}

function isAllowedPrivateKey(key) {
  return key && (
    key.startsWith("pengajuan/") ||
    key.startsWith("profile/") ||
    key.startsWith("siteloor/profile/")
  );
}

function encodeKey(key) {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

const b2 = new S3Client({
  region: "us-east-005",
  endpoint: process.env.B2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
  },
});

async function uploadToB2({ key, buffer, contentType }) {
  await b2.send(
    new PutObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream",
    })
  );

  const publicBaseUrl = trimSlash(process.env.B2_PUBLIC_URL);
  if (publicBaseUrl) {
    return `${publicBaseUrl}/${encodeKey(key)}`;
  }

  return `${trimSlash(process.env.B2_ENDPOINT)}/${process.env.B2_BUCKET_NAME}/${encodeKey(key)}`;
}

function keyFromB2Url(value) {
  const text = (value || "").toString().trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) return text;

  try {
    const url = new URL(text);
    const bucketName = process.env.B2_BUCKET_NAME;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "file" && parts[1] === bucketName) {
      return parts.slice(2).join("/");
    }
    if (parts[0] === bucketName) {
      return parts.slice(1).join("/");
    }
    return parts.join("/");
  } catch (_) {
    return null;
  }
}

async function deleteFromB2(keyOrUrl) {
  const key = keyFromB2Url(keyOrUrl);
  if (!key || !key.startsWith("pengajuan/")) return false;

  await b2.send(
    new DeleteObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: key,
    })
  );
  return true;
}

async function deleteManyFromB2(values = []) {
  const keys = [...new Set(values.map(keyFromB2Url).filter((key) => key && key.startsWith("pengajuan/")))];
  let deleted = 0;

  for (const key of keys) {
    await deleteFromB2(key);
    deleted += 1;
  }

  return deleted;
}

async function deletePrefixFromB2(prefix) {
  const normalizedPrefix = (prefix || "").toString().trim();
  if (!normalizedPrefix || !normalizedPrefix.startsWith("pengajuan/")) return 0;

  let deleted = 0;
  let continuationToken;

  do {
    const listResult = await b2.send(
      new ListObjectsV2Command({
        Bucket: process.env.B2_BUCKET_NAME,
        Prefix: normalizedPrefix,
        ContinuationToken: continuationToken,
      })
    );

    const objects = (listResult.Contents || [])
      .map((item) => item.Key)
      .filter(Boolean)
      .map((Key) => ({ Key }));

    if (objects.length) {
      await b2.send(
        new DeleteObjectsCommand({
          Bucket: process.env.B2_BUCKET_NAME,
          Delete: { Objects: objects, Quiet: true },
        })
      );
      deleted += objects.length;
    }

    continuationToken = listResult.IsTruncated
      ? listResult.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return deleted;
}

async function getSignedB2Url(keyOrUrl, expiresIn = 300) {
  const key = keyFromB2Url(keyOrUrl);

  if (!isAllowedPrivateKey(key)) {
    throw new Error("Invalid B2 key");
  }

  const command = new GetObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: key,
  });

  return await getSignedUrl(b2, command, {
    expiresIn, // detik, 300 = 5 menit
  });
}

async function getB2Object(keyOrUrl) {
  const key = keyFromB2Url(keyOrUrl);

  if (!isAllowedPrivateKey(key)) {
    throw new Error("Invalid B2 key");
  }

  const result = await b2.send(
    new GetObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: key,
    })
  );

  return { key, result };
}

module.exports = { uploadToB2, deleteFromB2, deleteManyFromB2, deletePrefixFromB2, keyFromB2Url, getSignedB2Url, getB2Object };
