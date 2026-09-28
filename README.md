# Git Workspace

Extensão do Cursor com ações Git para todos os repositórios do workspace.

O pull usa a extensão Git embutida do editor, então vale a credencial, o remote e o `pull.rebase` já configurados em cada repositório.

## Uso

1. Abra a paleta de comandos.
2. Rode um dos comandos:
   - **Git: Pull em todos os repositórios do workspace**
   - **Git: Limpar todas as alterações em todos os repositórios**
   - **Git: Trocar todos os repositórios para uma branch remota**
   - **Git: Criar branch a partir de outra nos repositórios selecionados**
3. Confirme. O resultado aparece na notificação e no painel **Git Workspace**.

Criar branch pede a branch de origem e o nome da nova. Depois dá para marcar os serviços ou usar o botão de selecionar todos. Em cada um, a extensão faz fetch da origem e `git switch -c <nova> --no-track origin/<origem>`.

Trocar branch pede o nome, faz `git fetch` e `git switch -C <branch> --track origin/<branch>` em cada repositório. A branch local fica igual à última versão do remoto.

Limpar alterações executa `git reset --hard HEAD` e `git clean -fd` em cada repositório. Arquivos ignorados permanecem. A confirmação é obrigatória porque a operação apaga mudanças ainda não commitadas.

Os quatro ícones ficam no título do Source Control.

Pastas do workspace que não são repositório Git são ignoradas. Se a pasta raiz não for um repositório, a extensão procura repositórios no nível imediatamente abaixo.

Repositórios sem remote, sem upstream ou com HEAD desanexado são ignorados e listados na saída.

## Desenvolvimento

```bash
npm install
npm run compile
```

Abra esta pasta no Cursor e inicie a configuração **Rodar extensão**.
