import { describe, expect, it } from "vitest";
import {
  buildGeocodeQuery,
  collapseRepeats,
  selectAddress,
  toIndianPincode,
} from "./addressSelector.js";

// Every fixture below is a real row from a live Flex WIP export, trimmed only
// of the columns the selector does not read. Synthetic addresses would not have
// caught the truncation or the wrong-state case.

describe("toIndianPincode", () => {
  it("accepts a real 6-digit PIN", () => {
    expect(toIndianPincode("600095")).toBe("600095");
    expect(toIndianPincode(" 632001 ")).toBe("632001");
  });

  it("rejects what normalizePincode alone would let through", () => {
    // A phone number in the pincode column: digits survive stripping and then
    // silently miss every lookup downstream.
    expect(toIndianPincode("9840012345")).toBeNull();
    // Indian PINs never start with zero.
    expect(toIndianPincode("012345")).toBeNull();
    expect(toIndianPincode("")).toBeNull();
    expect(toIndianPincode(null)).toBeNull();
  });
});

describe("collapseRepeats", () => {
  it("collapses the un-separated repetition seen in Common Address", () => {
    expect(collapseRepeats("SalemSalemSalem")).toBe("Salem");
  });

  it("collapses a whole address doubled with a separator", () => {
    const once =
      "No.434/A5,434/A6,435/2,437/A, chennai free trade zone, Mannur, Sriperumbudur";
    expect(collapseRepeats(`${once} ${once}`)).toBe(once);
  });

  it("leaves a normal address untouched", () => {
    const address = "19/3, 3rd Floor, Arni Road, Above More Super Market, Kosapet";
    expect(collapseRepeats(address)).toBe(address);
  });

  it("does not mangle legitimately repeating tokens", () => {
    expect(collapseRepeats("Nagar Nagar Road 12")).toBe("Nagar Nagar Road 12");
  });
});

describe("selectAddress", () => {
  it("returns none when both columns are empty", () => {
    const result = selectAddress({ customerAddress: null, commonAddress: null });
    expect(result.source).toBe("none");
    expect(result.text).toBeNull();
  });

  it("treats placeholder junk as empty rather than as an address", () => {
    const result = selectAddress({ customerAddress: "N/A", commonAddress: "  -  " });
    expect(result.source).toBe("none");
    expect(result.text).toBeNull();
  });

  it("rejects an all-digit cell that is not an address", () => {
    const result = selectAddress({ customerAddress: "600095600095", commonAddress: null });
    expect(result.source).toBe("none");
  });

  it("uses Common Address on the 50 rows where Customer Address is blank", () => {
    const result = selectAddress({
      customerAddress: null,
      commonAddress: "ASHOKLEYLAND-2, NO.77 ELECTRONIC COMPLEX SIPCOT-2 ,PERANDAPALLI, Hosur",
      customerCity: "Hosur",
      customerPincode: "635109",
    });
    expect(result.source).toBe("common");
    expect(result.pincode).toBe("635109");
  });

  it("uses Customer Address when Common Address is blank", () => {
    const result = selectAddress({
      customerAddress: "shri ram finance limited no 32 1st floor trunk road porur",
      commonAddress: null,
      customerPincode: "600116",
    });
    expect(result.source).toBe("customer");
  });

  // THE CASE THAT DECIDES THE WHOLE DESIGN. Customer Address points at
  // Maharashtra; Common Address, city and pincode all agree on Tamil Nadu.
  it("rejects a Customer Address that contradicts the row's own city", () => {
    const result = selectAddress({
      customerAddress:
        "Arshiya Free Trade Warhousing  Zone wh - 4, Sai Village, Tal-Panvel, Dist.-Raigad",
      commonAddress:
        "No.434/A5,434/A6,435/2,437/A, chennai free trade zone, Mannur, Sriperumbudur",
      customerCity: "sriperumbudur",
      customerState: "Tamil Nadu",
      customerPincode: "602105",
    });
    expect(result.source).toBe("common");
    expect(result.text).toContain("Sriperumbudur");
    expect(result.text).not.toContain("Raigad");
  });

  it("prefers the complete address over a truncated one ending on a separator", () => {
    const result = selectAddress({
      customerAddress: "19/3, 3rd Floor, Arni Road, Above More Super Market, Kosapet -",
      commonAddress: "98/3, 3rd Floor, Arni Road, Above More Super Market, Kosapet",
      customerCity: "Vellore",
      customerPincode: "632001",
    });
    expect(result.source).toBe("common");
    expect(result.reason.customerTruncated).toBe(true);
    expect(result.reason.commonTruncated).toBe(false);
  });

  it("strips a dangling separator when both candidates are truncated", () => {
    // Both ends are cut, so the better one still wins — but the trailing "-"
    // must not reach the geocoder.
    const result = selectAddress({
      customerAddress: "19/3, 3rd Floor, Arni Road, Kosapet -",
      commonAddress: "98/3, 3rd Floor, Arni Road, Above More Super Market, Kosapet -",
      customerCity: "Vellore",
      customerPincode: "632001",
    });
    expect(result.reason.customerTruncated).toBe(true);
    expect(result.reason.commonTruncated).toBe(true);
    expect(result.text).toBe("98/3, 3rd Floor, Arni Road, Above More Super Market, Kosapet");
  });

  it("prefers the longer address when one is a strict prefix of the other", () => {
    const result = selectAddress({
      customerAddress: "NO-17 NEHRU G NAGAR 6TH STREET",
      commonAddress: "NO-17 NEHRU G NAGAR 6TH STREET ARAKKONAM, VELLORE",
      customerPincode: "631001",
    });
    expect(result.source).toBe("common");
    expect(result.reason.prefixRelation).toBe(true);
  });

  it("keeps Customer Address when IT is the longer side of a prefix pair", () => {
    const result = selectAddress({
      customerAddress: "NO-17 NEHRU G NAGAR 6TH STREET ARAKKONAM, VELLORE",
      commonAddress: "NO-17 NEHRU G NAGAR 6TH STREET",
      customerPincode: "631001",
    });
    expect(result.source).toBe("customer");
    expect(result.reason.prefixRelation).toBe(true);
  });

  it("prefers the candidate carrying the row's own pincode", () => {
    const result = selectAddress({
      customerAddress: "Some Street, Chennai 600095",
      commonAddress: "A Longer Rambling Address That Says Nothing Useful At All Here",
      customerPincode: "600095",
    });
    expect(result.source).toBe("customer");
  });

  it("is deterministic on the 425 rows where both columns are identical", () => {
    const identical = "no 52 radhan chantnagar near water tank arakonam ranipet";
    const first = selectAddress({
      customerAddress: identical,
      commonAddress: identical,
      customerPincode: "631001",
    });
    const second = selectAddress({
      customerAddress: identical,
      commonAddress: identical,
      customerPincode: "631001",
    });
    expect(first.source).toBe(second.source);
    expect(first.text).toBe(second.text);
    expect(first.text).toBe(identical);
  });
});

describe("buildGeocodeQuery", () => {
  it("appends city, state and pincode that the address does not already carry", () => {
    const query = buildGeocodeQuery({
      customerAddress: "VIt vellore tamil nadu",
      commonAddress: null,
      customerCity: "vellore",
      customerState: "Tamil Nadu",
      customerPincode: "632014",
    });
    // City and state are already present in the address, so only the pincode
    // is appended — repeating them measurably hurts some providers.
    expect(query).toBe("VIt vellore tamil nadu, 632014");
  });

  it("appends everything missing", () => {
    const query = buildGeocodeQuery({
      customerAddress: "shri ram finance limited no 32 1st floor trunk road porur",
      commonAddress: null,
      customerCity: "Kanchipuram",
      customerState: "Tamil Nadu",
      customerPincode: "600116",
    });
    expect(query).toBe(
      "shri ram finance limited no 32 1st floor trunk road porur, Kanchipuram, Tamil Nadu, 600116",
    );
  });

  it("returns null rather than a city-only query when there is no address", () => {
    const query = buildGeocodeQuery({
      customerAddress: null,
      commonAddress: null,
      customerCity: "Chennai",
      customerState: "Tamil Nadu",
      customerPincode: "600095",
    });
    expect(query).toBeNull();
  });
});
