import type {
  CallPlanParsedRecord,
  FlexWipParsedRecord,
  ParsedSourceFile,
  RenderwaysParsedRecord,
} from "../../types/sourceRecords.js";
import {
  dedupeRowsByTicket,
  findDuplicateTicketKeys,
  type TicketDedupeRow,
} from "../normalization/dedupeRowsByTicket.js";
import {
  cleanString,
  normalizeCaseId,
  normalizePincode,
  normalizeTicketId,
  parseAgingDays,
  parseExcelDate,
} from "../normalization/valueNormalizer.js";
import { readExcelSheet } from "./excelWorkbookReader.js";
import { findDuplicates } from "./duplicateDetector.js";
import { getCell } from "./rowAccess.js";

function buildParsedSourceFile<TRecord extends {
  normalizedTicketId?: string | null;
  normalizedCaseId?: string | null;
  rowNumber: number;
} & TicketDedupeRow>(
  records: TRecord[],
  issues: ParsedSourceFile<TRecord>["issues"],
): ParsedSourceFile<TRecord> {
  const duplicateNormalizedTicketIds = findDuplicates(
    records.map((record) => record.normalizedTicketId ?? null),
  );
  const { dedupedRows, duplicateCount } = dedupeRowsByTicket(records);
  const residualDuplicateTicketIds = findDuplicateTicketKeys(dedupedRows);

  if (residualDuplicateTicketIds.length > 0) {
    throw new Error(
      `Duplicate ticket IDs remain after parse dedupe: ${residualDuplicateTicketIds.join(", ")}`,
    );
  }

  if (duplicateCount > 0) {
    console.info("[sourceParsers] Removed duplicate parsed rows", {
      duplicateCount,
      duplicateNormalizedTicketIds,
    });
  }

  return {
    records: dedupedRows,
    issues,
    duplicateNormalizedTicketIds,
    duplicateNormalizedCaseIds: findDuplicates(
      dedupedRows.map((record) => record.normalizedCaseId ?? null),
    ),
    duplicateCount,
  };
}

export function parseFlexWipReport(
  filePath: string,
): ParsedSourceFile<FlexWipParsedRecord> {
  const sheet = readExcelSheet(filePath, "FLEX_WIP");
  const records: FlexWipParsedRecord[] = [];
  const issues: ParsedSourceFile<FlexWipParsedRecord>["issues"] = [];

  for (const row of sheet.rows) {
    const ticketId = cleanString(getCell(row.values, ["Ticket ID", "TicketId", "Ticket No"]));
    const normalizedTicketId = normalizeTicketId(ticketId);
    const caseId = cleanString(getCell(row.values, ["Case ID", "CaseId", "Case No"]));
    const normalizedCaseId = caseId ? normalizeCaseId(caseId) : null;

    if (!ticketId || !normalizedTicketId) {
      issues.push({
        rowNumber: row.rowNumber,
        field: "Ticket ID",
        message: "Flex WIP row is missing Ticket ID",
      });
      continue;
    }

    records.push({
      ticketId,
      normalizedTicketId,
      caseId,
      normalizedCaseId,
      createTime: parseExcelDate(getCell(row.values, ["Create Time", "CreateTime", "Created Time", "Case Created Time"])),
      product: cleanString(getCell(row.values, ["Product", "Product Name"])),
      flexStatus: cleanString(getCell(row.values, ["Status", "Flex Status"])),
      woOtcCode: cleanString(getCell(row.values, ["WO OTC Code", "WO OTC CODE", "WO-OTC Code"])),
      accountName: cleanString(getCell(row.values, ["Account Name"])),
      customerName: cleanString(getCell(row.values, ["Customer Name"])),
      contact: cleanString(getCell(row.values, ["Contact", "Contact Number", "Phone"])),
      customerEmail: cleanString(getCell(row.values, ["Customer Email", "Customer Mail", "Email"])),
      partDescription: cleanString(getCell(row.values, ["Part Description", "Part"])),
      customerPincode: normalizePincode(getCell(row.values, ["Customer Pincode", "Pincode", "Pin Code"])),
      productLineName: cleanString(getCell(row.values, ["Product Line Name", "ProductLineName", "Product Line"])),
      workLocation: cleanString(getCell(row.values, ["Work Location", "WorkLocation", "ASP Code", "ASP"])),
      businessSegment: cleanString(getCell(row.values, ["Business Segment", "BusinessSegment", "Business segment"])),
      productSerialNo: cleanString(getCell(row.values, ["Product Serial No", "Product S.No", "Product SN", "Serial No", "Serial Number"])),
      rawRow: row.rawRow,
      rowNumber: row.rowNumber,
    });
  }

  return buildParsedSourceFile(records, issues);
}

export function parseRenderwaysReport(
  filePath: string,
): ParsedSourceFile<RenderwaysParsedRecord> {
  const sheet = readExcelSheet(filePath, "RENDERWAYS");
  const records: RenderwaysParsedRecord[] = [];
  const issues: ParsedSourceFile<RenderwaysParsedRecord>["issues"] = [];

  for (const row of sheet.rows) {
    const ticketId = cleanString(getCell(row.values, ["Ticket ID", "TicketId", "Ticket No"]));
    const normalizedTicketId = ticketId ? normalizeTicketId(ticketId) : null;
    const caseId = cleanString(getCell(row.values, ["Case ID", "CaseId", "Case No"]));
    const normalizedCaseId = normalizeCaseId(caseId);

    if (!caseId || !normalizedCaseId) {
      issues.push({
        rowNumber: row.rowNumber,
        field: "Case ID",
        message: "Renderways row is missing Case ID",
      });
      continue;
    }

    records.push({
      ticketId,
      normalizedTicketId,
      caseId,
      normalizedCaseId,
      partnerAccept: parseExcelDate(getCell(row.values, ["Partner Accept", "Partner Accepted", "Case Created Time"])),
      wipAging: cleanString(getCell(row.values, ["WIP Aging", "WIP aging"])),
      wipAgingCategory: cleanString(getCell(row.values, ["WIP Aging Category"])),
      rtplStatus: cleanString(getCell(row.values, ["RTPL Status", "RTPL status", "Morning Status"])),
      hpOwner: cleanString(getCell(row.values, ["HP Owner", "HP Owner Status"])),
      rcaMessage: cleanString(getCell(row.values, ["RCA Message", "RCA"])),
      productType: cleanString(getCell(row.values, ["Product Type", "Product"])),
      callClassification: cleanString(getCell(row.values, ["Call Classification", "Segment"])),
      customerType: cleanString(getCell(row.values, ["Customer Type", "CustomerType", "Customer type"])),
      wipChangedFromMorningReport: cleanString(getCell(row.values, ["WIP Changed From Morning Report", "WIP Changes From Morning Report", "Wip Chnages From Morning Report", "WIP Changed"])),
      currentStatusAging: parseAgingDays(getCell(row.values, ["Current Status Aging", "current status aging", "Status Aging"])),
      rawRow: row.rawRow,
      rowNumber: row.rowNumber,
    });
  }

  return buildParsedSourceFile(records, issues);
}

export function parseCallPlanReport(
  filePath: string,
): ParsedSourceFile<CallPlanParsedRecord> {
  const sheet = readExcelSheet(filePath, "CALL_PLAN");
  const records: CallPlanParsedRecord[] = [];
  const issues: ParsedSourceFile<CallPlanParsedRecord>["issues"] = [];

  for (const row of sheet.rows) {
    const ticketId = cleanString(getCell(row.values, ["Ticket ID", "TicketId", "Ticket No"]));
    const normalizedTicketId = normalizeTicketId(ticketId);

    if (!ticketId || !normalizedTicketId) {
      // Check if row has any Call Plan-relevant data at all.
      // Rows from the Open Call sheet may contain values only in
      // non-Call-Plan columns (e.g. Product, Segment) — skip those
      // silently instead of flagging them as parse errors.
      const hasCallPlanData =
        !!cleanString(getCell(row.values, ["Morning Status", "RTPL Status"])) ||
        !!cleanString(getCell(row.values, ["Engineer", "engg.", "Engg.", "engg", "Engineer Name"])) ||
        !!cleanString(getCell(row.values, ["Location", "Location Name"]));

      if (hasCallPlanData) {
        issues.push({
          rowNumber: row.rowNumber,
          field: "Ticket ID",
          message: "Call Plan row is missing Ticket ID",
        });
      }
      continue;
    }

    records.push({
      ticketId,
      normalizedTicketId,
      morningStatus: cleanString(getCell(row.values, ["Morning Status", "RTPL Status"])),
      engineer: cleanString(getCell(row.values, ["Engineer", "engg.","Engg.", "engg", "Engineer Name"])),
      location: cleanString(getCell(row.values, ["Location", "Location Name"])),
      rawRow: row.rawRow,
      rowNumber: row.rowNumber,
    });
  }

  return buildParsedSourceFile(records, issues);
}
