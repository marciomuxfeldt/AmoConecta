# AmoConecta: configuração de acesso à equipe

## 1. Aplicar a migração

Antes de publicar o novo servidor, abra o SQL Editor do projeto Supabase e execute todo o conteúdo de:

`supabase/migrations/202609260015_team_access_and_audit.sql`

A migração cria as tabelas de membros, convites, sessões, recuperação de senha e auditoria; adiciona as colunas de atribuição às campanhas; e insere como membros ativos os usuários Auth existentes cujo e-mail termina em `@amo.delivery`.

As novas rotas do servidor dependem dessas tabelas. Não publique o servidor antes da migração.

Se não houver nenhum membro ativo após a migração, crie primeiro um usuário confiável `@amo.delivery` em Authentication → Users no Supabase Dashboard e, em seguida, adicione-o à equipe:

```sql
INSERT INTO public.membro_equipe (
  auth_user_id, email, nome, ativo, criado_em
)
SELECT
  id,
  lower(email),
  coalesce(
    nullif(raw_user_meta_data ->> 'name', ''),
    nullif(raw_user_meta_data ->> 'full_name', ''),
    split_part(email, '@', 1)
  ),
  true,
  now()
FROM auth.users
WHERE lower(email) = lower('pessoa@amo.delivery')
  AND lower(email) LIKE '%@amo.delivery'
ON CONFLICT (auth_user_id) DO NOTHING;
```

Substitua o endereço pelo e-mail do membro inicial. Isso não habilita cadastro público.

## 2. Conferir configurações de e-mail e URL

Convites e recuperação de senha são mensagens transacionais enviadas diretamente pelo Resend. Elas não entram na fila de campanhas e não consultam nem alteram `ENVIO_LIBERADO` ou o modo de segurança.

Confirme no gerenciamento de Secrets/variáveis do workspace que o servidor tem:

- `SESSION_SECRET`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`
- `SENDER_EMAIL`
- `SENDER_NAME`
- `APP_BASE_URL`

`SENDER_EMAIL` precisa estar verificado no Resend. `APP_BASE_URL` deve apontar para a base pública do AmoConecta e produzir os caminhos `/accept-invite` e `/reset-password`. `REPLY_TO_EMAIL` é opcional.

O fluxo usa o Supabase Auth Admin API para criar usuários confirmados, portanto funciona com **Enable Sign Ups** desativado. Não habilite cadastro público para usar convites.

## 3. Publicar as mudanças

Depois de aplicar o SQL e conferir a configuração:

1. Publique/reinicie o API Server e o frontend AmoConecta.
2. Se o worker for executado em um processo ou implantação separados, publique também as mudanças nele e reinicie-o.
3. O worker precisa receber estes arquivos junto com a migração:
   - `artifacts/api-server/src/lib/worker.ts`
   - `artifacts/api-server/src/lib/audit-events.ts`
   - `supabase/migrations/202609260015_team_access_and_audit.sql`

O worker grava auditoria quando pausa uma campanha automaticamente e registra o autor como **Sistema**. As regras atuais de envio, confirmações, modo de segurança, webhooks e exportação BI não são alteradas por esta migração.

## 4. Verificação inicial

1. Entre com um membro ativo `@amo.delivery`.
2. Abra **Equipe** e envie um convite para outro endereço `@amo.delivery`.
3. Confirme o recebimento do link e a ativação com nome e senha.
4. Verifique que o novo membro aparece na lista e que a recuperação de senha envia um link de uso único.
5. Confirme que a equipe não permite desativar a própria conta nem o último membro ativo.
6. Crie, agende e pause uma campanha de teste; confira a atribuição e a linha do tempo da campanha.