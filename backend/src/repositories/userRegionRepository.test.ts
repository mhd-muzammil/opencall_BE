import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findAdditionalRegionIdsForUser,
  setAdditionalUserRegions,
} from "./userRegionRepository.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("../config/database.js", () => ({
  query: mocks.query,
  withTransaction: mocks.withTransaction,
}));

describe("userRegionRepository", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.withTransaction.mockReset();
    mocks.query.mockResolvedValue({ rows: [] });
  });

  it("returns the additional region ids for a user", async () => {
    mocks.query.mockResolvedValue({
      rows: [{ region_id: "region-a" }, { region_id: "region-b" }],
    });

    const regionIds = await findAdditionalRegionIdsForUser("user-1");

    const [sql, params] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain("FROM user_regions");
    expect(sql).toContain("WHERE user_id = $1");
    expect(params).toEqual(["user-1"]);
    expect(regionIds).toEqual(["region-a", "region-b"]);
  });

  it("replaces additional regions with delete-then-insert in one transaction", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    mocks.withTransaction.mockImplementation(async (callback) => callback(client));

    await setAdditionalUserRegions("user-1", ["region-a", "region-b"]);

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(3);

    const [deleteSql, deleteParams] = client.query.mock.calls[0] ?? [];
    expect(deleteSql).toContain("DELETE FROM user_regions WHERE user_id = $1");
    expect(deleteParams).toEqual(["user-1"]);

    const [firstInsertSql, firstInsertParams] = client.query.mock.calls[1] ?? [];
    expect(firstInsertSql).toContain("INSERT INTO user_regions");
    expect(firstInsertParams).toEqual(["user-1", "region-a"]);

    const [, secondInsertParams] = client.query.mock.calls[2] ?? [];
    expect(secondInsertParams).toEqual(["user-1", "region-b"]);
  });

  it("clears all additional regions when given an empty list", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    mocks.withTransaction.mockImplementation(async (callback) => callback(client));

    await setAdditionalUserRegions("user-1", []);

    expect(client.query).toHaveBeenCalledTimes(1);
    const [deleteSql, deleteParams] = client.query.mock.calls[0] ?? [];
    expect(deleteSql).toContain("DELETE FROM user_regions WHERE user_id = $1");
    expect(deleteParams).toEqual(["user-1"]);
  });
});
