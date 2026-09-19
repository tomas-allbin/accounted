import type { LegalFormProfile } from './types'

/**
 * Handelsbolag: a juridisk person owned by two or more delägare who are
 * taxed for the bolag's result themselves (the bolag files INK4, each
 * delägare an N3A). The profile models the common small case, delägare who
 * are fysiska personer, which is what the fork this ships in books for.
 *
 * - Calendar year: BFL 3 kap 1 § 2 st binds a handelsbolag in which a fysisk
 *   person is taxed for the income to the calendar year. A bolag owned only
 *   by juridiska personer may run a brutet räkenskapsår; that case is not
 *   modelled.
 * - Equity: the year closes to 2099 "Årets resultat" like an AB, but there
 *   is no 2098-style carry. Where the result goes at the next year start is
 *   the resultatfördelning between the delägare (bolagsavtalet), booked as
 *   an ordinary verifikat 2099 → the delägare's kapitalkonto (2010/2020 or
 *   the company's own numbering), so `priorYearCarry` is null and the
 *   engine posts no automatic omföring.
 * - Owner money: BAS 2013 (egna uttag) and 2018 (egna insättningar), the
 *   enskild firma column of the booking templates.
 * - Regelverk: årsbokslut under BFNAR 2017:3 (the K1 förenklade årsbokslut,
 *   BFNAR 2006:1, is for enskilda näringsidkare only); no årsredovisning
 *   unless a juridisk person is a delägare, which is out of scope.
 * - VAT: a bolag on helårsmoms files by the 26th of the second month after
 *   the beskattningsår regardless of EU trade (SFL 26 kap 33 §; 33 b § lists
 *   handelsbolag among its exceptions).
 */
export const SE_HANDELSBOLAG: LegalFormProfile = {
  jurisdiction: 'SE',
  code: 'handelsbolag',
  label: 'Handelsbolag',
  creationFlag: 'NEXT_PUBLIC_HANDELSBOLAG_ENABLED',
  identity: { orgId: 'organisationsnummer' },
  fiscalYear: { calendarOnly: true },
  bookkeeping: {
    defaultMethod: 'cash',
    // BFNAR 2017:3 (årsbokslut): the 5 000 kr periodisation threshold applies
    // as under K2.
    simplifiedRegelverk: 'K2',
    templateColumn: 'base',
  },
  equity: {
    closing: '2099',
    closingName: 'Årets resultat',
    priorYearCarry: null,
    hasOwners: true,
    settlement: { withdrawal: '2013', contribution: '2018' },
  },
  filings: {
    incomeReturn: 'INK4',
    booksCurrentTax: false,
    corporateTaxDispositions: false,
    arsredovisning: false,
    frameworks: ['K2'],
    annualVatSchedule: 'second_month',
  },
  glossary: { entity: 'bolaget', owner: 'Delägare', meeting: null },
}
