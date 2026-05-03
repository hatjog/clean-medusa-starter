# Joint Controller Agreement — Umowa o współadministrowaniu

> **DRAFT — pending legal team review pre-Phase-B-activation.**
> Niniejszy szablon zapewnia operacyjną strukturę 8 sekcji wymaganych
> przez RODO art. 26. Treść finalna podlega rewizji prawnej.

**Wersja**: {{ jca_version }}
**Data wygenerowania**: {{ generation_date }}
**Data podpisu**: {{ signed_date_placeholder }}

---

## 1. Identyfikacja stron

**Współadministrator A (BonBeauty)**
- Nazwa: {{ controller.name }}
- Adres prawny: {{ controller.legal_address }}
- NIP: {{ controller.tax_id }}

**Współadministrator B (Vendor)**
- Nazwa: {{ vendor.name }}
- Adres prawny: {{ vendor.legal_address }}
- NIP: {{ vendor.tax_id }}

## 2. Przedmiot i czas trwania

Niniejsza umowa reguluje wspólne przetwarzanie danych osobowych w ramach
platformy BonBeauty multi-vendor od daty {{ flag_flip_date }} bezterminowo,
z możliwością wypowiedzenia zgodnie z sekcją 8.

## 3. Role i odpowiedzialności (podział)

- BonBeauty odpowiada za: obsługę platformy, ogólne bezpieczeństwo, kontrolę
  dostępu administracyjnego, retencję danych zgodnie z DPIA §3.
- Vendor odpowiada za: prawidłowość ofert, komunikację z klientami,
  realizację usług, jakość danych wprowadzanych do platformy.

## 4. Podmioty danych i kategorie danych osobowych

- **Podmioty**: klienci końcowi (osoby fizyczne korzystające z platformy).
- **Kategorie**: imię, nazwisko, adres email, numer telefonu, adres
  dostarczenia usługi, historia rezerwacji, preferencje usługowe.
- Wykluczone: szczególne kategorie danych (RODO art. 9) chyba że ujawnione
  dobrowolnie przez klienta w ramach realizacji usługi.

## 5. Środki bezpieczeństwa

- Szyfrowanie w spoczynku (PostgreSQL TDE) i w tranzycie (TLS 1.3+).
- Kontrola dostępu rolowa (RBAC) — vendor widzi wyłącznie własnych klientów.
- Audyt dostępu logowany w sposób tamper-evident (hash chain).
- Backup z retencją zgodnie z DPIA §5.

## 6. Polityka subprocessorów

- BonBeauty stosuje listę zatwierdzonych subprocessorów (PostgreSQL hosting,
  CDN, providers email/SMS). Vendor zostanie powiadomiony o zmianach z 30-dniowym
  wyprzedzeniem.
- Vendor NIE może wykorzystywać własnych subprocessorów bez uprzedniej zgody
  BonBeauty.

## 7. Obsługa praw podmiotów danych

- Punkt kontaktowy dla wniosków RODO art. 15-22: BonBeauty.
- Vendor zobowiązany jest do współpracy w zakresie 7 dni roboczych w
  realizacji wniosków (np. usunięcie danych, eksport, sprostowanie).
- Wnioski przekazywane przez BonBeauty na adres vendora w trybie ticket.

## 8. Wypowiedzenie i podpisy

Każda strona może wypowiedzieć umowę z 90-dniowym wypowiedzeniem. W przypadku
wypowiedzenia vendor traci dostęp do danych klientów; dane historyczne
pozostają w archiwum BonBeauty zgodnie z polityką retencji.

**Podpis BonBeauty:** _______________________
Imię i nazwisko: _______________________
Data: _______________________

**Podpis Vendor:** _______________________
Imię i nazwisko: {{ vendor.name }}
Data: {{ signed_date_placeholder }}
