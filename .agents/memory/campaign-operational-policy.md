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

Uma coorte pós-retomada com zero envios não é motivo para usar o histórico acumulado: ela precisa poder iniciar os novos envios. Marco ausente na resposta não deve ser confundido com uma campanha nunca retomada.

**Why:** Uma pausa real aconteceu antes de qualquer novo envio porque o marco salvo não chegou à avaliação; usar o acumulado recriou o ciclo de pausa imediatamente.

**How to apply:** Verifique o caminho de leitura até a decisão, não apenas a fórmula isolada. Uma amostra insuficiente aguarda os mínimos do período novo.

Não altere ENVIO_LIBERADO nem o modo de segurança, não mexa na lógica de assinatura dos webhooks e não implemente coordenação de limite de taxa entre processos neste lote.

**Why:** O usuário delimitou explicitamente o lote, que se originou de uma campanha real em andamento.

**How to apply:** Não enviar mensagens nem modificar a campanha real para verificar esse trabalho. Preferir testes locais e SQL de aplicação manual.