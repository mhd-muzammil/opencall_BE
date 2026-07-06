import { z } from "zod";

const editableTextSchema = z.string().nullable().optional();

const editableDateTimeSchema = editableTextSchema.refine(
  (value) => {
    if (value === undefined || value === null || value.trim() === "") {
      return true;
    }

    return !Number.isNaN(Date.parse(value));
  },
  { message: "Case Created Time must be a valid date/time" },
);

function normalizeDateTime(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value.trim() === "") {
    return null;
  }

  return new Date(value).toISOString();
}

export const reportRowEditRequestSchema = z
  .object({
    engineer: editableTextSchema,
    rtpl_status: editableTextSchema,
    customer_mail: editableTextSchema,
    rca: editableTextSchema,
    remarks: editableTextSchema,
    manual_notes: editableTextSchema,
    location: editableTextSchema,
    segment: editableTextSchema,
    case_created_time: editableDateTimeSchema,
    wip_aging: editableTextSchema,
    status_aging: editableTextSchema,
    hp_owner_status: editableTextSchema,
    part: editableTextSchema,
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one editable field is required",
  })
  .transform((body) => ({
    engineer: body.engineer,
    rtplStatus: body.rtpl_status,
    customerMail: body.customer_mail,
    rca: body.rca,
    remarks: body.remarks,
    manualNotes: body.manual_notes,
    location: body.location,
    segment: body.segment,
    caseCreatedTime: normalizeDateTime(body.case_created_time),
    wipAging: body.wip_aging,
    statusAging: body.status_aging,
    hpOwnerStatus: body.hp_owner_status,
    part: body.part,
  }));
