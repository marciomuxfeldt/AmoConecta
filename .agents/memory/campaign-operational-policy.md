---
name: Campaign operational scope
description: User constraints on exclusion, reputation recovery and external validation.
---

Excluir da fila é uma decisão desta campanha, nunca uma supressão permanente da pessoa. Preserve o registro e o motivo; desfaça enquanto a campanha não terminou.

**Why:** O usuário precisa que o BI explique quem estava na lista e por que não recebeu; alterar supressao destruiria essa distinção.

**How to apply:** Não transforme resultados de validação externa em bloqueios globais sem um novo pedido. O validador externo pertence a um lote futuro; a ferramenta atual apenas recebe o CSV dos reprovados.

Após retomar, a taxa acumulada continua visível, mas somente os envios posteriores à retomada decidem nova pausa.

**Why:** Usar a taxa acumulada para o freio cria um ciclo de retomada e pausa, mesmo após remover o segmento ruim; eventos tardios de envios antigos não pertencem ao período novo.

**How to apply:** Preserve essa separação ao mudar relatórios, gatilhos ou o processamento de eventos; não filtre apenas pela hora de chegada do webhook.

Não altere ENVIO_LIBERADO nem o modo de segurança, não mexa na lógica de assinatura dos webhooks e não implemente coordenação de limite de taxa entre processos neste lote.

**Why:** O usuário delimitou explicitamente o lote, que se originou de uma campanha real em andamento.

**How to apply:** Não enviar mensagens nem modificar a campanha real para verificar esse trabalho. Preferir testes locais e SQL de aplicação manual.