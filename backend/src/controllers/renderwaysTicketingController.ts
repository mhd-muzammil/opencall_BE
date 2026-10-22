import type { RequestHandler } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import {
  getCustomer,
  getTicket,
  isRenderwaysConfigured,
  listCustomers,
  listTickets,
} from "../services/renderways/renderwaysClient.js";
import {
  isRenderwaysId,
  parseCustomerListQuery,
  parseTicketListQuery,
} from "../services/renderways/ticketingParams.js";

/**
 * Ticketing System: a read-only, live view of Renderways (RTPL customer app)
 * customers and the tickets they raise. Keeps the Renderways service
 * credentials on the server; the OpenCall web client calls these endpoints
 * instead of Renderways directly.
 */

const EMPTY_PAGE = { page: 1, limit: 0, total: 0, pages: 1 };

export const listTicketingCustomersController: RequestHandler = asyncHandler(
  async (request, response) => {
    if (!isRenderwaysConfigured()) {
      response.json({ data: { configured: false, customers: [], pagination: EMPTY_PAGE } });
      return;
    }
    const result = await listCustomers(parseCustomerListQuery(request.query));
    response.json({ data: { configured: true, ...result } });
  },
);

export const getTicketingCustomerController: RequestHandler = asyncHandler(
  async (request, response) => {
    const id = request.params.customerId;
    if (!isRenderwaysId(id)) {
      throw badRequest("Not a Renderways customer id");
    }
    response.json({ data: await getCustomer(id) });
  },
);

export const listTicketingTicketsController: RequestHandler = asyncHandler(
  async (request, response) => {
    if (!isRenderwaysConfigured()) {
      response.json({ data: { configured: false, tickets: [], pagination: EMPTY_PAGE } });
      return;
    }
    const result = await listTickets(parseTicketListQuery(request.query));
    response.json({ data: { configured: true, ...result } });
  },
);

export const getTicketingTicketController: RequestHandler = asyncHandler(
  async (request, response) => {
    const id = request.params.ticketId;
    if (!isRenderwaysId(id)) {
      throw badRequest("Not a Renderways ticket id");
    }
    response.json({ data: await getTicket(id) });
  },
);
