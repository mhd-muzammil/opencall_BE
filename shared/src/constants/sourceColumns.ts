import type { UploadSourceType } from "../types/report.js";

export interface RequiredColumnDefinition {
  canonical: string;
  aliases: readonly string[];
}

export const SOURCE_COLUMN_REQUIREMENTS: Record<
  UploadSourceType,
  readonly RequiredColumnDefinition[]
> = {
  FLEX_WIP: [
    { canonical: "Ticket ID", aliases: ["Ticket ID", "TicketId", "Ticket No"] },
    { canonical: "Product", aliases: ["Product", "Product Name"] },
    { canonical: "Status", aliases: ["Status", "Flex Status"] },
    { canonical: "WO OTC Code", aliases: ["WO OTC Code", "WO OTC CODE", "WO-OTC Code"] },
    { canonical: "Account Name", aliases: ["Account Name"] },
    { canonical: "Customer Name", aliases: ["Customer Name"] },
    { canonical: "Contact", aliases: ["Contact", "Contact Number", "Phone", "Customer Phone No"] },
    { canonical: "Customer Email", aliases: ["Customer Email", "Customer Mail", "Email", "Customer Email Id"] },
    { canonical: "Part Description", aliases: ["Part Description", "Part"] },
    { canonical: "Customer Pincode", aliases: ["Customer Pincode", "Pincode", "Pin Code"] },
    { canonical: "Product Line Name", aliases: ["Product Line Name", "ProductLineName", "Product Line"] },
    { canonical: "Work Location", aliases: ["Work Location", "WorkLocation", "ASP Code", "ASP"] },
    { canonical: "Business Segment", aliases: ["Business Segment", "BusinessSegment", "Business segment"] },
  ],
  RENDERWAYS: [
    { canonical: "Case ID", aliases: ["Case ID", "CaseId", "Case No"] },
    { canonical: "Partner Accept", aliases: ["Partner Accept", "Partner Accepted", "Case Created Time"] },
    { canonical: "WIP Aging", aliases: ["WIP Aging", "WIP aging"] },
    { canonical: "WIP Aging Category", aliases: ["WIP Aging Category"] },
    { canonical: "HP Owner", aliases: ["HP Owner", "HP Owner Status"] },
    { canonical: "RCA Message", aliases: ["RCA Message", "RCA"] },
    { canonical: "Product Type", aliases: ["Product Type"] },
    { canonical: "Call Classification", aliases: ["Call Classification"] },
  ],
  CALL_PLAN: [
    { canonical: "Ticket ID", aliases: ["Ticket ID", "TicketId", "Ticket No"] },
    { canonical: "Morning Status", aliases: ["Morning Status", "RTPL Status"] },
    { canonical: "Engineer", aliases: ["Engineer", "engg.","Engg.", "engg", "Engineer Name"] },
    { canonical: "Location", aliases: ["Location", "Location Name"] },
  ],
} as const;
