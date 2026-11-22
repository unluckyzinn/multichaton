const TWITCH_ICON_SVG = `<svg viewBox="0 0 24 24" fill="#9146ff" aria-hidden="true"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/></svg>`;
const KICK_ICON_SVG = `<svg viewBox="0 0 24 24" fill="#53fc18" aria-hidden="true"><path d="M3 2h6v7h2V6h2V3h7v6h-3v3h-3v2h3v3h3v5h-7v-3h-2v-3H9v6H3V2z"/></svg>`;

export class RaffleManager {
  constructor() {
    this.isRunning = false;
    this.keyword = "!sorteio";
    this.activeFilters = new Set(); // vazio = Todos
    this.participants = new Map();
    this.winner = null;

    this.el = {
      btnOpen: document.getElementById("btn-raffle"),
      backdrop: document.getElementById("raffle-backdrop"),
      btnClose: document.getElementById("btn-raffle-close"),
      statusPill: document.getElementById("raffle-status-pill"),
      keywordInput: document.getElementById("raffle-keyword"),
      filterAllBtn: document.getElementById("raffle-filter-all"),
      filterChips: document.querySelectorAll(".raffle-filter-chip"),
      countLabel: document.getElementById("raffle-count"),
      recentEntries: document.getElementById("raffle-recent-entries"),
      winnerCard: document.getElementById("raffle-winner-card"),
      winnerPlatform: document.getElementById("raffle-winner-platform"),
      winnerName: document.getElementById("raffle-winner-name"),
      winnerRoles: document.getElementById("raffle-winner-roles"),
      winnerMessages: document.getElementById("raffle-winner-messages"),
      btnToggle: document.getElementById("btn-raffle-toggle"),
      btnDraw: document.getElementById("btn-raffle-draw"),
      btnReset: document.getElementById("btn-raffle-reset"),
    };

    this.bindEvents();
    this.syncUI();
  }

  bindEvents() {
    this.el.btnOpen?.addEventListener("click", () => this.openModal());
    this.el.btnClose?.addEventListener("click", () => this.closeModal());

    this.el.backdrop?.addEventListener("click", (e) => {
      if (e.target === this.el.backdrop) {
        this.closeModal();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.el.backdrop && !this.el.backdrop.hidden) {
        this.closeModal();
      }
    });

    this.el.filterChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const filter = chip.dataset.rfilter;
        if (filter === "all") {
          this.activeFilters.clear();
        } else if (this.activeFilters.has(filter)) {
          this.activeFilters.delete(filter);
        } else {
          this.activeFilters.add(filter);
        }
        this.syncFilterChips();
      });
    });

    this.el.btnToggle?.addEventListener("click", () => {
      if (this.isRunning) {
        this.stopRaffle();
      } else {
        this.startRaffle();
      }
    });

    this.el.btnDraw?.addEventListener("click", () => this.drawWinner());
    this.el.btnReset?.addEventListener("click", () => this.resetRaffle());
  }

  openModal() {
    if (!this.el.backdrop) return;
    this.el.backdrop.hidden = false;
    if (!this.isRunning && this.el.keywordInput) {
      this.el.keywordInput.focus();
      this.el.keywordInput.select();
    }
  }

  closeModal() {
    if (!this.el.backdrop) return;
    this.el.backdrop.hidden = true;
  }

  startRaffle() {
    const rawWord = String(this.el.keywordInput?.value || "").trim();
    if (!rawWord) {
      this.el.keywordInput?.focus();
      return;
    }

    this.keyword = rawWord.toLowerCase();
    this.isRunning = true;
    this.syncUI();
  }

  stopRaffle() {
    this.isRunning = false;
    this.syncUI();
  }

  resetRaffle() {
    this.isRunning = false;
    this.participants.clear();
    this.winner = null;
    if (this.el.recentEntries) this.el.recentEntries.innerHTML = "";
    if (this.el.winnerCard) this.el.winnerCard.hidden = true;
    this.syncUI();
  }

  syncFilterChips() {
    const isAll = this.activeFilters.size === 0;
    this.el.filterAllBtn?.classList.toggle("active", isAll);
    this.el.filterChips.forEach((chip) => {
      const f = chip.dataset.rfilter;
      if (f === "all") return;
      chip.classList.toggle("active", this.activeFilters.has(f));
    });
  }

  syncUI() {
    this.syncFilterChips();

    if (this.el.keywordInput) this.el.keywordInput.disabled = this.isRunning;

    if (this.el.statusPill) {
      this.el.statusPill.textContent = this.isRunning ? "Ao vivo" : "Parado";
      this.el.statusPill.classList.toggle("active", this.isRunning);
    }

    if (this.el.btnOpen) {
      this.el.btnOpen.classList.toggle("running", this.isRunning);
    }

    if (this.el.btnToggle) {
      this.el.btnToggle.textContent = this.isRunning
        ? "Encerrar Inscrições"
        : "Iniciar Sorteio";
      this.el.btnToggle.classList.toggle("stop", this.isRunning);
    }

    const total = this.participants.size;
    if (this.el.countLabel) {
      this.el.countLabel.textContent = String(total);
    }
    if (this.el.btnDraw) {
      this.el.btnDraw.disabled = total === 0;
    }
  }

  matchesMessageFilters(msg) {
    if (this.activeFilters.size === 0) return true;

    const platformFilters = [];
    const roleFilters = [];

    for (const f of this.activeFilters) {
      if (f === "twitch" || f === "kick") platformFilters.push(f);
      else roleFilters.push(f);
    }

    const platformOk =
      platformFilters.length === 0 || platformFilters.includes(msg.platform);
    if (!platformOk) return false;

    if (roleFilters.length === 0) return true;

    return roleFilters.some((role) => {
      if (role === "subs") return Boolean(msg.isSub);
      if (role === "mod") return Boolean(msg.isMod || msg.isBroadcaster);
      if (role === "vip") return Boolean(msg.isVip);
      return false;
    });
  }

  matchesKeyword(text) {
    const clean = String(text || "")
      .trim()
      .toLowerCase();
    if (!clean || !this.keyword) return false;
    return clean.includes(this.keyword);
  }

  processIncomingMessage(msg) {
    if (!msg?.username || !msg?.text) return;

    if (
      this.winner &&
      msg.platform === this.winner.platform &&
      msg.username.toLowerCase() === this.winner.username.toLowerCase()
    ) {
      this.appendWinnerLiveMessage(msg.text);
    }

    if (!this.isRunning) return;
    if (!this.matchesKeyword(msg.text)) return;
    if (!this.matchesMessageFilters(msg)) return;

    const key = `${msg.platform}:${msg.username.toLowerCase()}`;
    if (this.participants.has(key)) return;

    const entry = {
      key,
      platform: msg.platform,
      username: msg.username,
      color: msg.color || "",
      isSub: Boolean(msg.isSub),
      isMod: Boolean(msg.isMod || msg.isBroadcaster),
      isVip: Boolean(msg.isVip),
    };

    this.participants.set(key, entry);
    this.renderRecentEntryPill(entry);
    this.syncUI();
  }

  renderRecentEntryPill(entry) {
    if (!this.el.recentEntries) return;
    const pill = document.createElement("span");
    pill.className = "raffle-entry-pill";
    pill.innerHTML =
      entry.platform === "twitch" ? TWITCH_ICON_SVG : KICK_ICON_SVG;

    const nameSpan = document.createElement("span");
    nameSpan.textContent = entry.username;
    pill.appendChild(nameSpan);

    this.el.recentEntries.prepend(pill);
    while (this.el.recentEntries.children.length > 14) {
      this.el.recentEntries.removeChild(this.el.recentEntries.lastChild);
    }
  }

  drawWinner() {
    const list = Array.from(this.participants.values());
    if (!list.length) return;

    const randomBuffer = new Uint32Array(1);
    crypto.getRandomValues(randomBuffer);
    const chosen = list[randomBuffer[0] % list.length];

    this.winner = chosen;
    this.isRunning = false;
    this.syncUI();

    if (!this.el.winnerCard) return;
    this.el.winnerCard.hidden = false;

    if (this.el.winnerPlatform) {
      this.el.winnerPlatform.innerHTML =
        chosen.platform === "twitch" ? TWITCH_ICON_SVG : KICK_ICON_SVG;
    }
    if (this.el.winnerName) {
      this.el.winnerName.textContent = chosen.username;
      if (chosen.color) this.el.winnerName.style.color = chosen.color;
    }
    if (this.el.winnerRoles) {
      const roles = [];
      if (chosen.isMod) roles.push("MOD");
      if (chosen.isVip) roles.push("VIP");
      if (chosen.isSub) roles.push("SUB");
      this.el.winnerRoles.textContent = roles.length
        ? `• ${roles.join(" / ")}`
        : "";
    }
    if (this.el.winnerMessages) {
      this.el.winnerMessages.innerHTML =
        '<span class="raffle-winner-empty">Aguardando o vencedor mandar mensagem...</span>';
    }
  }

  appendWinnerLiveMessage(text) {
    if (!this.el.winnerMessages) return;
    const emptyNote = this.el.winnerMessages.querySelector(
      ".raffle-winner-empty",
    );
    if (emptyNote) emptyNote.remove();

    const line = document.createElement("div");
    line.textContent = `• ${text}`;
    this.el.winnerMessages.appendChild(line);
    this.el.winnerMessages.scrollTop = this.el.winnerMessages.scrollHeight;
  }
}
