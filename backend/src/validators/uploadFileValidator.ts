import type { UploadSourceType } from "@opencall/shared";
import type {
  UploadedSourceFile,
  UploadFieldName,
} from "../types/upload.js";
import { badRequest } from "../utils/httpError.js";

const FIELD_TO_SOURCE: Record<UploadFieldName, UploadSourceType> = {
  flexWipReport: "FLEX_WIP",
  renderwaysReport: "RENDERWAYS",
  callPlan: "CALL_PLAN",
};

const ALL_FIELDS = Object.keys(FIELD_TO_SOURCE) as UploadFieldName[];
const REQUIRED_FIELDS: UploadFieldName[] = ["flexWipReport"];

export function getUploadedSourceFiles(
  files: Express.Multer.File[] | Record<string, Express.Multer.File[]> | undefined,
): UploadedSourceFile[] {
  if (!files || Array.isArray(files)) {
    throw badRequest("Expected multipart files for report sources");
  }

  const missingFields = REQUIRED_FIELDS.filter((fieldName) => {
    return !files[fieldName]?.[0];
  });

  if (missingFields.length > 0) {
    throw badRequest("Missing required report files", {
      missingFields,
      requiredFields: REQUIRED_FIELDS,
      optionalFields: ALL_FIELDS.filter((fieldName) => !REQUIRED_FIELDS.includes(fieldName)),
    });
  }

  return ALL_FIELDS.flatMap((fieldName) => {
    const uploadedFiles = files[fieldName] ?? [];

    if (uploadedFiles.length === 0) {
      return [];
    }

    return uploadedFiles.map((file) => ({
      fieldName,
      sourceType: FIELD_TO_SOURCE[fieldName],
      file,
    }));
  });
}
