// ============================================================
// 金融系统 - 货币、银行、贷款与金融危机
// Finance System — currencies, banks, loans & financial crises
// ============================================================

import {
  Currency, CurrencyType, Bank, Loan, FinancialCrisis, FinancialCrisisType,
  EconomyEvent, EconomyEventType
} from "./types";
import type { FinanceSystemSnapshot } from "./politico-economy-snapshot";

export class FinanceSystem {
  currencies: Map<string, Currency> = new Map();
  banks: Map<string, Bank> = new Map();
  activeCrises: FinancialCrisis[] = [];
  events: EconomyEvent[] = [];
  round: number = 0;
  crisisCounter: number = 0;

  private eventCounter: number = 0;

  constructor() {
    this.registerDefaultCurrencies();
  }

  // 注册默认货币 / Seed base currencies
  registerDefaultCurrencies(): void {
    this.registerCurrency({ id: "gold_coin", name: "金币", type: "commodity", issuer: "common", supply: 10000, stability: 80 });
    this.registerCurrency({ id: "spirit_stone", name: "灵石", type: "commodity", issuer: "common", supply: 5000, stability: 70 });
    this.registerCurrency({ id: "spirit_voucher", name: "灵石券", type: "credit", issuer: "common", supply: 20000, stability: 50 });

    // 返回值必须看。`setExchangeRate` 在任一货币没注册时返回 false 而**不设汇率**，
    // 丢掉返回值的后果是「默认汇率悄悄不存在」：`convert()` 后面查不到汇率，
    // 兑换按别的路径算，而没有任何一处会报错。
    // 这三种货币就在上面两行刚注册过，所以失败只可能是**代码写错了**（id 拼错、
    // 顺序被人调换），该当场炸掉，不该带着错汇率继续跑。
    for (const [from, to, rate] of [
      ["gold_coin", "spirit_voucher", 10],
      ["spirit_stone", "spirit_voucher", 50],
    ] as const) {
      if (!this.setExchangeRate(from, to, rate)) {
        throw new Error(`默认汇率没能设上：${from} → ${to}（货币未注册？检查上面的 registerCurrency）`);
      }
    }
  }

  // 注册货币 / Register a new currency
  registerCurrency(config: {
    id: string;
    name: string;
    type: CurrencyType;
    issuer: string;
    supply?: number;
    stability?: number;
  }): Currency {
    const currency: Currency = {
      id: config.id,
      name: config.name,
      type: config.type,
      issuer: config.issuer,
      exchangeRate: {},
      supply: config.supply ?? 1000,
      stability: config.stability ?? 50,
    };
    this.currencies.set(config.id, currency);
    return currency;
  }

  // 设置双向汇率 / Set bidirectional exchange rate
  setExchangeRate(fromId: string, toId: string, rate: number): boolean {
    const from = this.currencies.get(fromId);
    const to = this.currencies.get(toId);
    if (!from || !to) return false;

    from.exchangeRate[toId] = rate;
    to.exchangeRate[fromId] = 1 / rate;
    return true;
  }

  // 货币兑换（含1%汇差）/ Convert currency with 1% spread
  convert(amount: number, fromCurrency: string, toCurrency: string): number | null {
    const from = this.currencies.get(fromCurrency);
    const to = this.currencies.get(toCurrency);
    if (!from || !to) return null;

    if (fromCurrency === toCurrency) return amount;

    const rate = from.exchangeRate[toCurrency];
    if (rate == null) return null;

    const spread = 1 - 0.01;
    return Math.floor(amount * rate * spread);
  }

  // 创建银行 / Create a new bank
  createBank(config: {
    id: string;
    name: string;
    location: string;
    factionId: string;
  }): Bank {
    const bank: Bank = {
      id: config.id,
      name: config.name,
      location: config.location,
      factionId: config.factionId,
      reserves: {},
      loans: [],
      stability: 70,
    };
    this.banks.set(config.id, bank);
    return bank;
  }

  // 获取银行 / Get a bank by ID
  getBank(id: string): Bank | undefined {
    return this.banks.get(id);
  }

  // 获取所有银行 / Get all banks
  getAllBanks(): Bank[] {
    return Array.from(this.banks.values());
  }

  /** Internal persistence primitive. Untrusted snapshots are validated by the engine. */
  exportForSnapshot(): FinanceSystemSnapshot {
    return {
      currencies: Array.from(this.currencies.values()),
      banks: Array.from(this.banks.values()),
      activeCrises: this.activeCrises,
      events: this.events,
      round: this.round,
      crisisCounter: this.crisisCounter,
      eventCounter: this.eventCounter,
    };
  }

  /** Internal persistence primitive. Call only with validatePoliticoEconomySnapshot output. */
  replaceFromSnapshot(snapshot: FinanceSystemSnapshot): void {
    this.currencies = new Map(snapshot.currencies.map(currency => [currency.id, currency]));
    this.banks = new Map(snapshot.banks.map(bank => [bank.id, bank]));
    this.activeCrises = snapshot.activeCrises;
    this.events = snapshot.events;
    this.round = snapshot.round;
    this.crisisCounter = snapshot.crisisCounter;
    this.eventCounter = snapshot.eventCounter;
  }

  // 存款 / Deposit currency into a bank
  deposit(bankId: string, currencyId: string, amount: number): boolean {
    const bank = this.banks.get(bankId);
    const currency = this.currencies.get(currencyId);
    if (!bank || !currency) return false;

    bank.reserves[currencyId] = (bank.reserves[currencyId] ?? 0) + amount;
    currency.supply = Math.max(0, currency.supply - amount);
    return true;
  }

  // 取款 / Withdraw currency from a bank
  withdraw(bankId: string, currencyId: string, amount: number): boolean {
    const bank = this.banks.get(bankId);
    const currency = this.currencies.get(currencyId);
    if (!bank || !currency) return false;

    const currentReserve = bank.reserves[currencyId] ?? 0;
    if (currentReserve < amount) return false;

    bank.reserves[currencyId] = currentReserve - amount;
    currency.supply += amount;
    return true;
  }

  // 发放贷款 / Issue a loan
  issueLoan(
    bankId: string,
    borrowerFactionId: string,
    amount: number,
    currencyId: string,
    interestRate: number,
    remainingRounds: number,
    collateral: string
  ): Loan | null {
    const bank = this.banks.get(bankId);
    if (!bank) return null;
    if (bank.stability < 30) return null;

    const loan: Loan = {
      id: `loan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      borrower: borrowerFactionId,
      amount,
      currencyId,
      interestRate,
      remainingRounds,
      collateral,
      defaulted: false,
    };

    const currentReserve = bank.reserves[currencyId] ?? 0;
    if (currentReserve < amount) return null;

    bank.reserves[currencyId] = currentReserve - amount;
    bank.loans.push(loan);

    return loan;
  }

  // 违约贷款 / Default a loan
  defaultLoan(loanId: string): boolean {
    for (const bank of this.banks.values()) {
      const loan = bank.loans.find(l => l.id === loanId);
      if (loan) {
        loan.defaulted = true;
        bank.stability = Math.max(0, bank.stability - 10);

        this.addEvent({
          type: "financial_crisis",
          description: `贷款 ${loanId}（${loan.borrower}）发生违约，影响银行 ${bank.name}`,
          affectedFactions: [loan.borrower, bank.factionId],
          data: { loanId, bankId: bank.id, amount: loan.amount, currencyId: loan.currencyId },
        });

        return true;
      }
    }
    return false;
  }

  // 触发金融危机 / Trigger a financial crisis
  triggerCrisis(config: {
    type: FinancialCrisisType;
    severity: number;
    name: string;
    description: string;
    affectedFactionIds: string[];
  }): FinancialCrisis {
    this.crisisCounter++;
    const crisis: FinancialCrisis = {
      id: `crisis_${this.crisisCounter}`,
      type: config.type,
      severity: config.severity,
      name: config.name,
      description: config.description,
      affectedFactionIds: config.affectedFactionIds,
      startedAtRound: this.round,
      resolved: false,
    };

    switch (config.type) {
      case "inflation":
        for (const c of this.currencies.values()) {
          c.stability = Math.max(0, c.stability - 10);
        }
        break;
      case "deflation":
        for (const c of this.currencies.values()) {
          c.stability = Math.max(0, c.stability - 5);
        }
        break;
      case "bank_run":
        for (const bank of this.banks.values()) {
          if (config.affectedFactionIds.includes(bank.factionId)) {
            bank.stability = Math.max(0, bank.stability - 30);
          }
        }
        break;
      case "default":
        for (const bank of this.banks.values()) {
          for (const loan of bank.loans) {
            if (config.affectedFactionIds.includes(loan.borrower)) {
              loan.defaulted = true;
            }
          }
        }
        break;
      case "hyperinflation":
        for (const c of this.currencies.values()) {
          c.stability = Math.max(0, c.stability - 30);
        }
        break;
      case "market_crash":
        for (const c of this.currencies.values()) {
          c.stability = Math.max(0, c.stability - 20);
        }
        break;
    }

    this.activeCrises.push(crisis);

    this.addEvent({
      type: "financial_crisis",
      description: `金融危机爆发：${config.name} — ${config.description}`,
      affectedFactions: config.affectedFactionIds,
      data: { crisisId: crisis.id, crisisType: config.type, severity: config.severity },
    });

    return crisis;
  }

  // 解除危机 / Resolve an active financial crisis
  resolveCrisis(crisisId: string): boolean {
    const crisis = this.activeCrises.find(c => c.id === crisisId);
    if (!crisis || crisis.resolved) return false;

    crisis.resolved = true;
    crisis.resolvedAtRound = this.round;

    this.addEvent({
      type: "financial_crisis",
      description: `金融危机「${crisis.name}」已在第 ${this.round} 回合解除`,
      affectedFactions: crisis.affectedFactionIds,
      data: { crisisId: crisis.id, resolvedAtRound: this.round },
    });

    return true;
  }

  // 获取活跃危机 / Get currently active (unresolved) crises
  getActiveCrises(): FinancialCrisis[] {
    return this.activeCrises.filter(c => !c.resolved);
  }

  // 推进回合 / Advance one financial round
  advanceRound(): EconomyEvent[] {
    this.round++;
    const newEvents: EconomyEvent[] = [];

    // 贷款处理：剩余期数-1，到期自动违约
    for (const bank of this.banks.values()) {
      for (const loan of bank.loans) {
        if (loan.defaulted) continue;

        loan.remainingRounds--;
        if (loan.remainingRounds <= 0) {
          loan.defaulted = true;
          bank.stability = Math.max(0, bank.stability - 10);

          newEvents.push({
            id: `evt_${++this.eventCounter}`,
            type: "financial_crisis",
            round: this.round,
            description: `贷款到期违约：${loan.borrower} 未能偿还 ${loan.amount} ${loan.currencyId}`,
            affectedFactions: [loan.borrower, bank.factionId],
            data: { loanId: loan.id, bankId: bank.id, amount: loan.amount, currencyId: loan.currencyId },
          });
        }
      }
    }

    // 货币稳定度随机波动 ±2
    for (const c of this.currencies.values()) {
      c.stability = Math.max(0, Math.min(100, c.stability + Math.floor(Math.random() * 5) - 2));
    }

    // 银行稳定度随机波动 ±1
    for (const bank of this.banks.values()) {
      bank.stability = Math.max(0, Math.min(100, bank.stability + Math.floor(Math.random() * 3) - 1));
    }

    // 5% 概率随机触发小型经济事件
    if (Math.random() < 0.05) {
      const minorEvents = ["市场价格波动", "铸币行调整兑换率", "某商会资金链紧张"];
      const desc = minorEvents[Math.floor(Math.random() * minorEvents.length)];

      newEvents.push({
        id: `evt_${++this.eventCounter}`,
        type: "market_shift",
        round: this.round,
        description: desc,
        affectedFactions: [],
        data: { minor: true },
      });
    }

    // 清理已解除危机：保留最近10条
    const resolved = this.activeCrises.filter(c => c.resolved);
    const unresolved = this.activeCrises.filter(c => !c.resolved);
    if (resolved.length > 10) {
      const keep = resolved.slice(-10);
      this.activeCrises = [...unresolved, ...keep];
    }

    for (const evt of newEvents) {
      this.addEvent(evt);
    }

    return newEvents;
  }

  // 获取系统状态 / Get current system state snapshot
  getState(): { currencies: Currency[]; activeCrises: FinancialCrisis[]; recentEvents: EconomyEvent[]; round: number } {
    return {
      currencies: Array.from(this.currencies.values()),
      activeCrises: [...this.activeCrises],
      recentEvents: this.events.slice(-20),
      round: this.round,
    };
  }

  // ── 内部方法 ──

  private addEvent(data: {
    type: EconomyEventType;
    description: string;
    affectedFactions: string[];
    data?: Record<string, unknown>;
  }): void {
    const event: EconomyEvent = {
      id: `evt_${++this.eventCounter}`,
      type: data.type,
      round: this.round,
      description: data.description,
      affectedFactions: data.affectedFactions,
      data: data.data,
    };
    this.events.push(event);
    if (this.events.length > 100) {
      this.events.shift();
    }
  }
}
