import { describe, expect, it } from "vitest";
import { addressKeyFor, buildGeocodableAddress } from "./geocodeAddress.js";

describe("addressKeyFor", () => {
  it("is stable for the same address", () => {
    expect(addressKeyFor("12, Anna Salai, Chennai")).toBe(
      addressKeyFor("12, Anna Salai, Chennai"),
    );
  });

  it("collapses punctuation, case and whitespace onto one key", () => {
    // The whole point of the cache: these must cost ONE provider call, not two.
    expect(addressKeyFor("12, Anna Salai., Chennai")).toBe(
      addressKeyFor("12  anna salai chennai"),
    );
  });

  it("keeps genuinely different addresses apart", () => {
    // Too loose a key would return the wrong building's coordinate.
    expect(addressKeyFor("12 Anna Salai, Chennai")).not.toBe(
      addressKeyFor("14 Anna Salai, Chennai"),
    );
  });

  it("is 32 hex characters", () => {
    expect(addressKeyFor("anything")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("buildGeocodableAddress", () => {
  it("builds text, key and pincode from the selected address", () => {
    const built = buildGeocodableAddress({
      customerAddress: "shri ram finance limited no 32 1st floor trunk road porur",
      commonAddress: null,
      customerCity: "Kanchipuram",
      customerState: "Tamil Nadu",
      customerPincode: "600116",
    });

    expect(built).not.toBeNull();
    expect(built!.pincode).toBe("600116");
    expect(built!.addressSource).toBe("customer");
    expect(built!.key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("always appends India so Indian streets cannot resolve abroad", () => {
    const built = buildGeocodableAddress({
      customerAddress: "no 52 radhan chantnagar water tank arakonam ranipet",
      commonAddress: null,
      customerPincode: "631001",
    });
    expect(built!.text.endsWith(", India")).toBe(true);
  });

  it("uses the address the selector chose, not Customer Address blindly", () => {
    // The Raigad row: Customer Address is in Maharashtra, the work order is not.
    const built = buildGeocodableAddress({
      customerAddress:
        "Arshiya Free Trade Warhousing  Zone wh - 4, Sai Village, Tal-Panvel, Dist.-Raigad",
      commonAddress:
        "No.434/A5,434/A6,435/2,437/A, chennai free trade zone, Mannur, Sriperumbudur",
      customerCity: "sriperumbudur",
      customerState: "Tamil Nadu",
      customerPincode: "602105",
    });

    expect(built!.addressSource).toBe("common");
    expect(built!.text).toContain("Sriperumbudur");
    expect(built!.text).not.toContain("Raigad");
  });

  it("returns null when there is no address worth paying for", () => {
    // City + pincode alone resolve to the locality centroid, which the free
    // pincode tier already provides.
    expect(
      buildGeocodableAddress({
        customerAddress: null,
        commonAddress: null,
        customerCity: "Chennai",
        customerState: "Tamil Nadu",
        customerPincode: "600095",
      }),
    ).toBeNull();
  });

  it("returns null for placeholder junk rather than geocoding it", () => {
    expect(
      buildGeocodableAddress({
        customerAddress: "N/A",
        commonAddress: "-",
        customerPincode: "600095",
      }),
    ).toBeNull();
  });

  it("gives two work orders at the same site one shared key", () => {
    const fields = {
      customerAddress: "IDFC FIRST BANK, GROUND FLOOR - No 82, OFFICERS LINE KRISHNA NAGAR",
      commonAddress: null,
      customerCity: "Vellore",
      customerState: "Tamil Nadu",
      customerPincode: "632001",
    };
    const a = buildGeocodableAddress(fields);
    const b = buildGeocodableAddress({ ...fields });
    expect(a!.key).toBe(b!.key);
  });
});
