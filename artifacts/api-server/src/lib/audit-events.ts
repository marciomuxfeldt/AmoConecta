import { supabaseAdminClient } from "./supabase";

export type AuditActor = {
  id: string | null;
  name: string;
  email: string | null;
};

export type AuditEventInput = {
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordAuditEvent(
  event: AuditEventInput,
): Promise<void> {
  const { error } = await supabaseAdminClient()
    .from("evento_auditoria")
    .insert({
      actor_user_id: event.actor.id,
      actor_name: event.actor.name,
      actor_email: event.actor.email,
      action: event.action,
      entity_type: event.entityType,
      entity_id: event.entityId ?? null,
      metadata: event.metadata ?? {},
    });
  if (error) throw error;
}

export function teamAuditActor(user: {
  id: string;
  email: string | null;
  name: string;
}): AuditActor {
  return { id: user.id, email: user.email, name: user.name };
}

export const systemAuditActor: AuditActor = {
  id: null,
  email: null,
  name: "Sistema",
};