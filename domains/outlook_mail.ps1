# Outlook (classic) helper for domains/outlook_mail.py. ASCII only; every user-facing text lives in Python.
# Input: one JSON object on stdin (UTF-8): modo (abrir|enviar), conta_email, para, cc, assunto, corpo.
# Output markers on stdout, one per line:
#   PASSO:antes_send | OK:aberto | OK:enviado | AVISO:destinatario_nao_resolvido | ERRO:<codigo>
# modo=abrir calls Display($false) and never Send(). modo=enviar calls Send() only after PASSO:antes_send.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Say([string]$texto) {
    [Console]::Out.WriteLine($texto)
    [Console]::Out.Flush()
}

$mail = $null
$mostrado = $false
$enviado = $false
try {
    $leitor = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
    $pedido = $leitor.ReadToEnd() | ConvertFrom-Json
    $modo = [string]$pedido.modo
    if ($modo -ne 'abrir' -and $modo -ne 'enviar') { throw 'CODE:outlook_indisponivel' }

    if ($modo -eq 'enviar') {
        # Sending needs a running Outlook; never start one just to send.
        if ($null -eq (Get-Process -Name OUTLOOK -ErrorAction SilentlyContinue)) { throw 'CODE:outlook_fechado' }
    }

    $outlook = New-Object -ComObject Outlook.Application
    $conta = $null
    foreach ($candidata in $outlook.Session.Accounts) {
        if ([string]$candidata.SmtpAddress -ieq [string]$pedido.conta_email) { $conta = $candidata; break }
    }
    # Never fall back to another account.
    if ($null -eq $conta) { throw 'CODE:conta_ausente' }

    $mail = $outlook.CreateItem(0)
    # Plain property assignment of SendUsingAccount raises no error but has no effect from PowerShell (read back as null, 2026-11-11).
    [void]$mail.GetType().InvokeMember('SendUsingAccount', [System.Reflection.BindingFlags]::SetProperty, $null, $mail, @($conta))
    # Outlook may ignore the assignment and keep the default account: read it back (-ne ignores case); applies to abrir and enviar.
    if ([string]$mail.SendUsingAccount.SmtpAddress -ne [string]$pedido.conta_email) { throw 'CODE:conta_ausente' }
    $mail.To = [string]$pedido.para
    $mail.CC = [string]$pedido.cc
    $mail.Subject = [string]$pedido.assunto
    $mail.Body = ([string]$pedido.corpo) -replace "`r?`n", "`r`n"

    $resolvidos = $true
    if ($mail.Recipients.Count -gt 0) { $resolvidos = [bool]$mail.Recipients.ResolveAll() }

    if ($modo -eq 'abrir') {
        if (-not $resolvidos) { Say 'AVISO:destinatario_nao_resolvido' }
        $mail.Display($false)
        $mostrado = $true
        # Display() alone left the window only on the taskbar when Outlook was started by this script (2026-11-11).
        try { $mail.GetInspector.Activate() } catch { }
        Say 'OK:aberto'
    } else {
        if (-not $resolvidos) { throw 'CODE:destinatario_nao_resolvido' }
        # From the next line on, anything but OK:enviado (a timeout or an exception inside Send()) is "uncertain" in Python,
        # never "nothing sent" (user decision, 2026-11-10); so Send() has no catch of its own.
        Say 'PASSO:antes_send'
        $mail.Send()
        $enviado = $true
        Say 'OK:enviado'
    }
} catch {
    $mensagem = [string]$_.Exception.Message
    if ($mensagem.StartsWith('CODE:')) {
        Say ('ERRO:' + $mensagem.Substring(5))
    } else {
        Say 'ERRO:outlook_indisponivel'
    }
} finally {
    # Discard the unsent draft on any failure; a displayed or sent item is left alone.
    if ($null -ne $mail -and -not $mostrado -and -not $enviado) {
        try { $mail.Close(1) } catch { }
    }
}
exit 0
