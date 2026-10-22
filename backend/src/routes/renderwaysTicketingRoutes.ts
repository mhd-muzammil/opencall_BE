import { Router } from "express";
import {
  getTicketingCustomerController,
  getTicketingTicketController,
  listTicketingCustomersController,
  listTicketingTicketsController,
} from "../controllers/renderwaysTicketingController.js";
import { requireAuthenticatedUser } from "../middlewares/authMiddleware.js";
import { requireRole } from "../middlewares/roleMiddleware.js";

/**
 * Ticketing System — Renderways (RTPL customer app) customers and their tickets,
 * read live from the Renderways API. Read-only, and SUPER_ADMIN only: it shows
 * customers' phone numbers, emails and addresses.
 */
export const renderwaysTicketingRouter = Router();

renderwaysTicketingRouter.use(requireAuthenticatedUser, requireRole(["SUPER_ADMIN"]));

// /customers?search=&status=active|inactive&page=&limit=
renderwaysTicketingRouter.get("/customers", listTicketingCustomersController);
// One customer, A to Z, with all their tickets.
renderwaysTicketingRouter.get("/customers/:customerId", getTicketingCustomerController);
// /tickets?search=&status=active|archived|<status>&priority=&overdue=true&page=&limit=
renderwaysTicketingRouter.get("/tickets", listTicketingTicketsController);
// One ticket with its device, location, conversation and history.
renderwaysTicketingRouter.get("/tickets/:ticketId", getTicketingTicketController);
