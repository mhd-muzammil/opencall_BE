import type { Request, Response } from "express";
import { z } from "zod";
import { requireCurrentUser } from "../services/rbac/regionAccessService.js";
import {
  listReportHistory,
  getReportHistoryDetail,
  renameReportHistory,
  removeReportHistory,
  duplicateReportHistory,
} from "../services/historyService.js";

const renameSchema = z.object({
  title: z.string().min(1),
});

export async function getHistoryListController(req: Request, res: Response) {
  try {
    const user = requireCurrentUser(req.currentUser);
    const history = await listReportHistory(user);
    res.json({ data: history });
  } catch (error) {
    res.status(500).json({
      error: {
        message: error instanceof Error ? error.message : "Internal Server Error",
      },
    });
  }
}

export async function getHistoryDetailController(req: Request, res: Response) {
  try {
    const user = requireCurrentUser(req.currentUser);
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: { message: "Missing ID" } });
    }
    const detail = await getReportHistoryDetail(id, user);
    res.json({ data: detail });
  } catch (error) {
    res.status(404).json({
      error: {
        message: error instanceof Error ? error.message : "Not Found",
      },
    });
  }
}

export async function renameHistoryController(req: Request, res: Response) {
  try {
    const user = requireCurrentUser(req.currentUser);
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: { message: "Missing ID" } });
    }

    const parsed = renameSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: { message: "Invalid title", details: parsed.error.flatten() },
      });
    }

    const result = await renameReportHistory(id, user, parsed.data.title);
    res.json({ data: result });
  } catch (error) {
    res.status(404).json({
      error: {
        message: error instanceof Error ? error.message : "Not Found",
      },
    });
  }
}

export async function deleteHistoryController(req: Request, res: Response) {
  try {
    const user = requireCurrentUser(req.currentUser);
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: { message: "Missing ID" } });
    }

    const result = await removeReportHistory(id, user);
    res.json({ data: result });
  } catch (error) {
    res.status(404).json({
      error: {
        message: error instanceof Error ? error.message : "Not Found",
      },
    });
  }
}

export async function duplicateHistoryController(req: Request, res: Response) {
  try {
    const user = requireCurrentUser(req.currentUser);
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: { message: "Missing ID" } });
    }

    const result = await duplicateReportHistory(id, user);
    res.json({ data: result });
  } catch (error) {
    res.status(404).json({
      error: {
        message: error instanceof Error ? error.message : "Not Found",
      },
    });
  }
}
