# Azdo Board Metrics MVP

Bu proje, Azure DevOps Boards'tan Work Item verilerini çekip (A/B/C geliştiricileri özelinde), **DueDate uyumu** ve **Efor (4 efor = 1 gün) tahmin uyumu** metriklerini hesaplayan basit bir dashboard sağlar.

## Önkoşullar
- .NET SDK 8
- Azure DevOps Personal Access Token (PAT) (scope: `vso.work` yeterli)

## Kurulum
1) Klasöre girin:
```bash
cd AzdoBoardMetrics
```

2) PAT ve org/project bilgisini env ile verin (önerilir):
```bash
# Windows PowerShell
$env:AZDO_ORG_URL="https://dev.azure.com/ORG"
$env:AZDO_PROJECT="PROJECT"
$env:AZDO_PAT="xxxxx"
```

3) Çalıştırın:
```bash
dotnet run
```

4) Tarayıcı:
- http://localhost:5000

## Ayarlar
`appsettings.json` -> `Azdo` bölümünde:
- `Users`: A/B/C e-posta (AssignedTo uniqueName ile eşleşir)
- `EffortField`: efor alanı (varsayılan `Microsoft.VSTS.Scheduling.Effort`)
- `DueDateField`: sizin DueDate alanınız (çoğu ortamda `Microsoft.VSTS.Scheduling.TargetDate`) (Analytics referansında geçer)
- `WorkdayEffortPerDay`: 4
- `UseBusinessDays`: true (Cumartesi/Pazar hariç)

Not: DueDate alanınız custom ise, referenceName’ini Azure DevOps -> Fields list endpoint’i ile doğrulayabilirsiniz.

## Kolektör nasıl çalışır?
- Arka planda periyodik olarak WIQL ile son değişen work item id’lerini alır
- `workitemsbatch` ile alanları toplu çeker (max 200)
- Her item için `revisions` ile state değişim tarihlerini çıkarır
- Metrikleri hesaplayıp SQLite DB’ye yazar

## API
- GET `/api/workitems`
- GET `/api/workitems/{id}`
- POST `/api/workitems/{id}/feedback`
- POST `/api/workitems/{id}/review-assignment`
- GET `/api/feedback/pool`

## Güvenlik
Bu MVP PAT'i server-side kullanır. Prod ortamda:
- KeyVault/secret manager
- En az ayrı bir service account
- Network + auth (Azure AD / Entra) önerilir.
