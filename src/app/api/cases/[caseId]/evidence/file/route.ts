import { after, NextRequest, NextResponse } from "next/server";

import { getRequestUserId } from "@/lib/auth/request";
import { runEvidenceJobs } from "@/lib/jobs/evidence-jobs";
import { reserveStorageObject } from "@/lib/evidence/storage";
import { createFileEvidenceForCase } from "@/lib/services/evidence-service";
import { jsonError } from "@/lib/utils/http";
import { MAX_UPLOAD_SIZE_BYTES } from "@/lib/validators";

type RouteContext = {
  params: Promise<{
    caseId: string;
  }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const userId = await getRequestUserId(request);

  if (!userId) {
    return jsonError("Unauthorized.", 401);
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return jsonError("File upload is required.");
  }

  if (file.size === 0) {
    return jsonError("Uploaded file is empty.");
  }

  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    return jsonError("Uploaded file exceeds the 20 MB limit.", 413);
  }

  const { caseId } = await context.params;
  const reserved = reserveStorageObject(file.name);

  try {
    const evidence = await createFileEvidenceForCase(userId, caseId, {
      originalName: file.name,
      mimeType: file.type || null,
      storageKey: reserved.storageKey,
      rawStorageUrl: reserved.rawStorageUrl,
      buffer: Buffer.from(await file.arrayBuffer()),
    });

    after(async () => {
      await runEvidenceJobs(evidence.id, caseId);
    });

    return NextResponse.json({ evidence }, { status: 201 });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not upload evidence.",
      400
    );
  }
}
