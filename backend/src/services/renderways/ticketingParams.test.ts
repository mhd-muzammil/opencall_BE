import { describe, expect, it } from "vitest";
import {
  absoluteFileUrl,
  isRenderwaysId,
  parseCustomerListQuery,
  parseTicketListQuery,
} from "./ticketingParams.js";

describe("isRenderwaysId", () => {
  it("accepts a Mongo ObjectId", () => {
    expect(isRenderwaysId("6a6a1212948e3c4247a2e5dd")).toBe(true);
  });

  it("rejects anything that could change the Renderways URL", () => {
    expect(isRenderwaysId("../users")).toBe(false);
    expect(isRenderwaysId("6a6a1212948e3c4247a2e5dd/comments")).toBe(false);
    expect(isRenderwaysId("")).toBe(false);
    expect(isRenderwaysId(undefined)).toBe(false);
  });
});

describe("parseCustomerListQuery", () => {
  it("defaults to the first page of 25, every account", () => {
    expect(parseCustomerListQuery({})).toEqual({
      search: undefined,
      page: 1,
      limit: 25,
      active: undefined,
    });
  });

  it("trims the search, caps the page size and maps the status", () => {
    expect(
      parseCustomerListQuery({ search: "  sumaiya ", page: "3", limit: "500", status: "inactive" }),
    ).toEqual({ search: "sumaiya", page: 3, limit: 100, active: false });
  });

  it("falls back on nonsense numbers", () => {
    const query = parseCustomerListQuery({ page: "-2", limit: "abc" });
    expect(query.page).toBe(1);
    expect(query.limit).toBe(25);
  });
});

describe("parseTicketListQuery", () => {
  it("keeps known statuses and priorities only", () => {
    expect(parseTicketListQuery({ status: "in_progress", priority: "urgent" })).toMatchObject({
      status: "in_progress",
      priority: "urgent",
    });
    expect(parseTicketListQuery({ status: "active" }).status).toBe("active");
    expect(parseTicketListQuery({ status: "deleted", priority: "asap" })).toMatchObject({
      status: undefined,
      priority: undefined,
    });
  });

  it("only turns on the overdue filter for the literal string true", () => {
    expect(parseTicketListQuery({ overdue: "true" }).overdue).toBe(true);
    expect(parseTicketListQuery({ overdue: "yes" }).overdue).toBeUndefined();
  });
});

describe("absoluteFileUrl", () => {
  it("joins relative upload paths onto the Renderways host", () => {
    expect(absoluteFileUrl("/uploads/a.jpg", "https://tsapi.systimus.in")).toBe(
      "https://tsapi.systimus.in/uploads/a.jpg",
    );
    expect(absoluteFileUrl("uploads/a.jpg", "https://tsapi.systimus.in")).toBe(
      "https://tsapi.systimus.in/uploads/a.jpg",
    );
  });

  it("leaves absolute URLs alone", () => {
    expect(absoluteFileUrl("https://cdn.example.com/a.jpg", "https://tsapi.systimus.in")).toBe(
      "https://cdn.example.com/a.jpg",
    );
  });
});
