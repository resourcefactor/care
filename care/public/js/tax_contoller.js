// Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
// License: GNU General Public License v3. See license.txt


frappe.provide("care.care");

care.care.ReceivingController = frappe.ui.form.Controller.extend({
    setup: function(frm, cdt, cdn) {
        var me = this;
        frappe.ui.form.on(this.frm.cscript.tax_table, "rate", function(frm, cdt, cdn) {
			cur_frm.cscript.calculate_taxes_and_totals();
		});

		frappe.ui.form.on(this.frm.cscript.tax_table, "tax_amount", function(frm, cdt, cdn) {
			cur_frm.cscript.calculate_taxes_and_totals();
		});

		frappe.ui.form.on(this.frm.cscript.tax_table, "row_id", function(frm, cdt, cdn) {
			cur_frm.cscript.calculate_taxes_and_totals();
		});

		frappe.ui.form.on(this.frm.cscript.tax_table, "included_in_print_rate", function(frm, cdt, cdn) {
			cur_frm.cscript.set_dynamic_labels();
			cur_frm.cscript.calculate_taxes_and_totals();
		});

		frappe.ui.form.on(this.frm.doctype, "apply_discount_on", function(frm) {
			if(frm.doc.additional_discount_percentage) {
				frm.trigger("additional_discount_percentage");
			} else {
				cur_frm.cscript.calculate_taxes_and_totals();
			}
		});
    },
//    onload: function(doc, cdt, cdn){
//        var me = this;
//        if(this.frm.fields_dict["items"].grid.get_field('item_code')) {
//			this.frm.set_query("item_tax_template", "items", function(doc, cdt, cdn) {
//				return me.set_query_for_item_tax_template(doc, cdt, cdn)
//			});
//		}
//    },
    onload_post_render: function() {
		if(this.frm.doc.__islocal && !(this.frm.doc.taxes || []).length
			&& !(this.frm.doc.__onload ? this.frm.doc.__onload.load_after_mapping : false)) {
			frappe.after_ajax(() => this.apply_default_taxes());
		} else if(this.frm.doc.__islocal && this.frm.doc.company && this.frm.doc["items"]
			&& !this.frm.doc.is_pos) {
			frappe.after_ajax(() => this.calculate_taxes_and_totals());
		}
	},
	set_query_for_item_tax_template: function(doc, cdt, cdn) {
		var item = frappe.get_doc(cdt, cdn);
		if(!item.item_code) {
			return doc.company ? {filters: {company: doc.company}} : {};
		} else {
			let filters = {
				'item_code': item.item_code,
				'valid_from': ["<=", doc.transaction_date || doc.bill_date || doc.posting_date],
				'item_group': item.item_group,
			}

			if (doc.tax_category)
				filters['tax_category'] = doc.tax_category;
			if (doc.company)
				filters['company'] = doc.company;
			return {
				query: "erpnext.controllers.queries.get_tax_template",
				filters: filters
			}
		}
	},
	apply_default_taxes() {
		var me = this;
		var taxes_and_charges_field = frappe.meta.get_docfield(me.frm.doc.doctype, "taxes_and_charges",
			me.frm.doc.name);

		if (!this.frm.doc.taxes_and_charges && this.frm.doc.taxes && this.frm.doc.taxes.length > 0) {
			return;
		}

		if (taxes_and_charges_field) {
			return frappe.call({
				method: "erpnext.controllers.accounts_controller.get_default_taxes_and_charges",
				args: {
					"master_doctype": taxes_and_charges_field.options,
					"tax_template": me.frm.doc.taxes_and_charges || "",
					"company": me.frm.doc.company
				},
				debounce: 2000,
				callback: function(r) {
					if(!r.exc && r.message) {
						frappe.run_serially([
							() => {
								// directly set in doc, so as not to call triggers
								if(r.message.taxes_and_charges) {
									me.frm.doc.taxes_and_charges = r.message.taxes_and_charges;
								}

								// set taxes table
								if(r.message.taxes) {
									me.frm.set_value("taxes", r.message.taxes);
								}
							},
							() => me.calculate_taxes_and_totals()
						]);
					}
				}
			});
		}
	},
	validate: function() {
	    this.calculate_taxes_and_totals(false);
	},
	taxes_and_charges: function() {
		var me = this;
		if(this.frm.doc.taxes_and_charges) {
			return this.frm.call({
				method: "erpnext.controllers.accounts_controller.get_taxes_and_charges",
				args: {
					"master_doctype": frappe.meta.get_docfield(this.frm.doc.doctype, "taxes_and_charges",
						this.frm.doc.name).options,
					"master_name": this.frm.doc.taxes_and_charges
				},
				callback: function(r) {
					if(!r.exc) {
						if(me.frm.doc.shipping_rule && me.frm.doc.taxes) {
							for (let tax of r.message) {
								me.frm.add_child("taxes", tax);
							}
							refresh_field("taxes");
						} else {
							me.frm.set_value("taxes", r.message);
							me.calculate_taxes_and_totals();
						}
					}
				}
			});
		}
	},
	calculate_taxes_and_totals: async function(update_paid_amount) {
		this.discount_amount_applied = false;
		this._calculate_taxes_and_totals();

		await this.calculate_shipping_charges();

//		 Advance calculation applicable to Sales /Purchase Invoice
		this.frm.refresh_fields();
	},

	_calculate_taxes_and_totals: function() {
		this.calculate_item_values();
		this.initialize_taxes();
		this.determine_exclusive_rate();
		this.calculate_net_total();
		this.calculate_taxes();
		this.manipulate_grand_total_for_inclusive_tax();
		this.calculate_totals();
		this._cleanup();
	},
	item_tax_template: function(doc, cdt, cdn) {
		var me = this;
		if(me.frm.updating_party_details) return;

		var item = frappe.get_doc(cdt, cdn);

		if(item.item_tax_template) {
			return this.frm.call({
				method: "erpnext.stock.get_item_details.get_item_tax_map",
				args: {
					company: me.frm.doc.company,
					item_tax_template: item.item_tax_template,
					as_json: true
				},
				callback: function(r) {
					if(!r.exc) {
						item.item_tax_rate = r.message;
						me.add_taxes_from_item_tax_template(item.item_tax_rate);
//						me.calculate_taxes_and_totals();
					}
				}
			});
		} else {
			item.item_tax_rate = "{}";
			me.calculate_taxes_and_totals();
		}
	},
	add_taxes_from_item_tax_template: function(item_tax_map) {
		let me = this;

		if (item_tax_map && cint(frappe.defaults.get_default("add_taxes_from_item_tax_template"))) {
			if (typeof (item_tax_map) == "string") {
				item_tax_map = JSON.parse(item_tax_map);
			}

			$.each(item_tax_map, function(tax, rate) {
				let found = (me.frm.doc.taxes || []).find(d => d.account_head === tax);
				if (!found) {
					let child = frappe.model.add_child(me.frm.doc, "taxes");
					child.charge_type = "On Net Total";
					child.account_head = tax;
					child.rate = 0;
				}
			});
		}
	},
	calculate_item_values: function() {
		let me = this;
		if (!this.discount_amount_applied) {
			$.each(this.frm.doc["items"] || [], function(i, item) {
				frappe.model.round_floats_in(item);
				item.net_rate = item.rate;
				item.amount = flt((item.rate * item.qty) - item.discount, precision("amount", item));
				item.net_amount = item.amount;
			});
		}
	},

	initialize_taxes: function() {
		var me = this;

		$.each(this.frm.doc["taxes"] || [], function(i, tax) {
			if (!tax.dont_recompute_tax) {
				tax.item_wise_tax_detail = {};
			}
			var tax_fields = ["total", "tax_amount_after_discount_amount",
				"tax_amount_for_current_item", "grand_total_for_current_item",
				"tax_fraction_for_current_item", "grand_total_fraction_for_current_item"];

			if (cstr(tax.charge_type) != "Actual" &&
				!(me.discount_amount_applied && me.frm.doc.apply_discount_on=="Grand Total")) {
				tax_fields.push("tax_amount");
			}

			$.each(tax_fields, function(i, fieldname) { tax[fieldname] = 0.0; });
			frappe.model.round_floats_in(tax);
		});
	},

	determine_exclusive_rate: function() {
		var me = this;

		var has_inclusive_tax = false;
		$.each(me.frm.doc["taxes"] || [], function(i, row) {
			if(cint(row.included_in_print_rate)) has_inclusive_tax = true;
		});
		if(has_inclusive_tax==false) return;

		$.each(me.frm.doc["items"] || [], function(n, item) {
			var item_tax_map = me._load_item_tax_rate(item.item_tax_rate);
			var cumulated_tax_fraction = 0.0;
			var total_inclusive_tax_amount_per_qty = 0;
			$.each(me.frm.doc["taxes"] || [], function(i, tax) {
				var current_tax_fraction = me.get_current_tax_fraction(tax, item_tax_map);
				tax.tax_fraction_for_current_item = current_tax_fraction[0];
				var inclusive_tax_amount_per_qty = current_tax_fraction[1];

				if(i==0) {
					tax.grand_total_fraction_for_current_item = 1 + tax.tax_fraction_for_current_item;
				} else {
					tax.grand_total_fraction_for_current_item =
						me.frm.doc["taxes"][i-1].grand_total_fraction_for_current_item +
						tax.tax_fraction_for_current_item;
				}

				cumulated_tax_fraction += tax.tax_fraction_for_current_item;
				total_inclusive_tax_amount_per_qty += inclusive_tax_amount_per_qty * flt(item.qty);
			});

			if(!me.discount_amount_applied && item.qty && (total_inclusive_tax_amount_per_qty || cumulated_tax_fraction)) {
				var amount = flt(item.amount) - total_inclusive_tax_amount_per_qty;
				item.net_amount = flt(amount / (1 + cumulated_tax_fraction));
				item.net_rate = item.qty ? flt(item.net_amount / item.qty, precision("amount", item)) : 0;
			}
		});
	},

	get_current_tax_fraction: function(tax, item_tax_map) {
		// Get tax fraction for calculating tax exclusive amount
		// from tax inclusive amount
		var current_tax_fraction = 0.0;
		var inclusive_tax_amount_per_qty = 0;

		if(cint(tax.included_in_print_rate)) {
			var tax_rate = this._get_tax_rate(tax, item_tax_map);

			if(tax.charge_type == "On Net Total") {
				current_tax_fraction = (tax_rate / 100.0);

			} else if(tax.charge_type == "On Previous Row Amount") {
				current_tax_fraction = (tax_rate / 100.0) *
					this.frm.doc["taxes"][cint(tax.row_id) - 1].tax_fraction_for_current_item;

			} else if(tax.charge_type == "On Previous Row Total") {
				current_tax_fraction = (tax_rate / 100.0) *
					this.frm.doc["taxes"][cint(tax.row_id) - 1].grand_total_fraction_for_current_item;
			} else if (tax.charge_type == "On Item Quantity") {
				inclusive_tax_amount_per_qty = flt(tax_rate);
			}
		}

		if(tax.add_deduct_tax && tax.add_deduct_tax == "Deduct") {
			current_tax_fraction *= -1;
			inclusive_tax_amount_per_qty *= -1;
		}
		return [current_tax_fraction, inclusive_tax_amount_per_qty];
	},

	_get_tax_rate: function(tax, item_tax_map) {
		return (Object.keys(item_tax_map).indexOf(tax.account_head) != -1) ?
			flt(item_tax_map[tax.account_head], precision("rate", tax)) : tax.rate;
	},

	calculate_net_total: function() {
		var me = this;
		this.frm.doc.total_qty = this.frm.doc.total = this.frm.doc.base_total = this.frm.doc.net_total = this.frm.doc.base_net_total = 0.0;

		$.each(this.frm.doc["items"] || [], function(i, item) {
			me.frm.doc.total += item.amount;
			me.frm.doc.total_qty += item.qty;
			me.frm.doc.base_total += item.base_amount;
			me.frm.doc.net_total += item.net_amount;
			me.frm.doc.base_net_total += item.base_net_amount;
			});
	},

	calculate_shipping_charges: function() {
		// Do not apply shipping rule for POS
		if (this.frm.doc.is_pos) {
			return;
		}

//		frappe.model.round_floats_in(this.frm.doc, ["total", "base_total", "net_total", "base_net_total"]);
		if (frappe.meta.get_docfield(this.frm.doc.doctype, "shipping_rule", this.frm.doc.name)) {
			return this.shipping_rule();
		}
	},

	calculate_taxes: function() {
		var me = this;
		this.frm.doc.rounding_adjustment = 0;
		var actual_tax_dict = {};

		// maintain actual tax rate based on idx
		$.each(this.frm.doc["taxes"] || [], function(i, tax) {
			if (tax.charge_type == "Actual") {
				actual_tax_dict[tax.idx] = flt(tax.tax_amount, precision("tax_amount", tax));
			}
		});

		$.each(this.frm.doc["items"] || [], function(n, item) {
			var item_tax_map = me._load_item_tax_rate(item.item_tax_rate);
			$.each(me.frm.doc["taxes"] || [], function(i, tax) {
				// tax_amount represents the amount of tax for the current step
				var current_tax_amount = me.get_current_tax_amount(item, tax, item_tax_map);

				// Adjust divisional loss to the last item
				if (tax.charge_type == "Actual") {
					actual_tax_dict[tax.idx] -= current_tax_amount;
					if (n == me.frm.doc["items"].length - 1) {
						current_tax_amount += actual_tax_dict[tax.idx];
					}
				}

				// accumulate tax amount into tax.tax_amount
				if (tax.charge_type != "Actual" &&
					!(me.discount_amount_applied && me.frm.doc.apply_discount_on=="Grand Total")) {
					tax.tax_amount += current_tax_amount;
				}

				// store tax_amount for current item as it will be used for
				// charge type = 'On Previous Row Amount'
				tax.tax_amount_for_current_item = current_tax_amount;

				// tax amount after discount amount
				tax.tax_amount_after_discount_amount += current_tax_amount;

				// for buying
				if(tax.category) {
					// if just for valuation, do not add the tax amount in total
					// hence, setting it as 0 for further steps
					current_tax_amount = (tax.category == "Valuation") ? 0.0 : current_tax_amount;

					current_tax_amount *= (tax.add_deduct_tax == "Deduct") ? -1.0 : 1.0;
				}

				// note: grand_total_for_current_item contains the contribution of
				// item's amount, previously applied tax and the current tax on that item
				if(i==0) {
					tax.grand_total_for_current_item = flt(item.net_amount + current_tax_amount);
				} else {
					tax.grand_total_for_current_item =
						flt(me.frm.doc["taxes"][i-1].grand_total_for_current_item + current_tax_amount);
				}

				// set precision in the last item iteration
				if (n == me.frm.doc["items"].length - 1) {
					me.set_cumulative_total(i, tax);
					// adjust Discount Amount loss in last tax iteration
					if ((i == me.frm.doc["taxes"].length - 1) && me.discount_amount_applied
						&& me.frm.doc.apply_discount_on == "Grand Total" && me.frm.doc.discount_amount) {
						me.frm.doc.rounding_adjustment = flt(me.frm.doc.grand_total -
							flt(me.frm.doc.discount_amount) - tax.total, precision("amount"));
					}
				}
			});
		});
	},

	set_cumulative_total: function(row_idx, tax) {
		var tax_amount = tax.tax_amount_after_discount_amount;
		if (tax.category == 'Valuation') {
			tax_amount = 0;
		}

		if (tax.add_deduct_tax == "Deduct") { tax_amount = -1*tax_amount; }

		if(row_idx==0) {
			tax.total = flt(this.frm.doc.net_total + tax_amount, precision("total", tax));
		} else {
			tax.total = flt(this.frm.doc["taxes"][row_idx-1].total + tax_amount, precision("total", tax));
		}
	},

	_load_item_tax_rate: function(item_tax_rate) {
		return item_tax_rate ? JSON.parse(item_tax_rate) : {};
	},

	get_current_tax_amount: function(item, tax, item_tax_map) {
		var tax_rate = this._get_tax_rate(tax, item_tax_map);
		var current_tax_amount = 0.0;

		// To set row_id by default as previous row.
		if(["On Previous Row Amount", "On Previous Row Total"].includes(tax.charge_type)) {
			if (tax.idx === 1) {
				frappe.throw(
					__("Cannot select charge type as 'On Previous Row Amount' or 'On Previous Row Total' for first row"));
			}
			if (!tax.row_id) {
				tax.row_id = tax.idx - 1;
			}
		}
		if(tax.charge_type == "Actual") {
			// distribute the tax amount proportionally to each item row
			var actual = flt(tax.tax_amount, precision("tax_amount", tax));
			current_tax_amount = this.frm.doc.net_total ?
				((item.net_amount / this.frm.doc.net_total) * actual) : 0.0;

		} else if(tax.charge_type == "On Net Total") {
			current_tax_amount = (tax_rate / 100.0) * item.net_amount;
		} else if(tax.charge_type == "On Previous Row Amount") {
			current_tax_amount = (tax_rate / 100.0) *
				this.frm.doc["taxes"][cint(tax.row_id) - 1].tax_amount_for_current_item;

		} else if(tax.charge_type == "On Previous Row Total") {
			current_tax_amount = (tax_rate / 100.0) *
				this.frm.doc["taxes"][cint(tax.row_id) - 1].grand_total_for_current_item;
		} else if (tax.charge_type == "On Item Quantity") {
			current_tax_amount = tax_rate * item.qty;
		}

		if (!tax.dont_recompute_tax) {
			this.set_item_wise_tax(item, tax, tax_rate, current_tax_amount);
		}

		return current_tax_amount;
	},

	set_item_wise_tax: function(item, tax, tax_rate, current_tax_amount) {
		// store tax breakup for each item
		let tax_detail = tax.item_wise_tax_detail;
		let key = item.item_code || item.item_name;

		if(typeof (tax_detail) == "string") {
			tax.item_wise_tax_detail = JSON.parse(tax.item_wise_tax_detail);
			tax_detail = tax.item_wise_tax_detail;
		}

		let item_wise_tax_amount = current_tax_amount * this.frm.doc.conversion_rate;
		if (tax_detail && tax_detail[key])
			item_wise_tax_amount += tax_detail[key][1];

		tax_detail[key] = [tax_rate, flt(item_wise_tax_amount, precision("base_tax_amount", tax))];
	},
	manipulate_grand_total_for_inclusive_tax: function() {
		var me = this;
		// if fully inclusive taxes and diff
		if (this.frm.doc["taxes"] && this.frm.doc["taxes"].length) {
			var any_inclusive_tax = false;
			$.each(this.frm.doc.taxes || [], function(i, d) {
				if(cint(d.included_in_print_rate)) any_inclusive_tax = true;
			});
			if (any_inclusive_tax) {
				var last_tax = me.frm.doc["taxes"].slice(-1)[0];
				var non_inclusive_tax_amount = frappe.utils.sum($.map(this.frm.doc.taxes || [],
					function(d) {
						if(!d.included_in_print_rate) {
							return flt(d.tax_amount_after_discount_amount);
						}
					}
				));
				var diff = me.frm.doc.total + non_inclusive_tax_amount
					- flt(last_tax.total, precision("grand_total"));

				if(me.discount_amount_applied && me.frm.doc.discount_amount) {
					diff -= flt(me.frm.doc.discount_amount);
				}

				diff = flt(diff, precision("rounding_adjustment"));

				if ( diff && Math.abs(diff) <= (5.0 / Math.pow(10, precision("tax_amount", last_tax))) ) {
					me.frm.doc.rounding_adjustment = diff;
				}
			}
		}
	},

	calculate_totals: function() {
		// Changing sequence can because of rounding adjustment issue and on-screen discrepancy
		var me = this;
		var tax_count = this.frm.doc["taxes"] ? this.frm.doc["taxes"].length : 0;
		this.frm.doc.grand_total = flt(tax_count
			? this.frm.doc["taxes"][tax_count - 1].total + flt(this.frm.doc.rounding_adjustment)
			: this.frm.doc.net_total);

		if(in_list(["Quotation", "Sales Order", "Delivery Note", "Sales Invoice", "POS Invoice"], this.frm.doc.doctype)) {
			this.frm.doc.base_grand_total = (this.frm.doc.total_taxes_and_charges) ?
				flt(this.frm.doc.grand_total * this.frm.doc.conversion_rate) : this.frm.doc.base_net_total;
		} else {
			// other charges added/deducted
			this.frm.doc.taxes_and_charges_added = this.frm.doc.taxes_and_charges_deducted = 0.0;
			if(tax_count) {
				$.each(this.frm.doc["taxes"] || [], function(i, tax) {
					if (in_list(["Valuation and Total", "Total"], tax.category)) {
						if(tax.add_deduct_tax == "Add") {
							me.frm.doc.taxes_and_charges_added += flt(tax.tax_amount_after_discount_amount);
						} else {
							me.frm.doc.taxes_and_charges_deducted += flt(tax.tax_amount_after_discount_amount);
						}
					}
				});

//				frappe.model.round_floats_in(this.frm.doc,
//					["taxes_and_charges_added", "taxes_and_charges_deducted"]);
			}

			this.frm.doc.base_grand_total = flt((this.frm.doc.taxes_and_charges_added || this.frm.doc.taxes_and_charges_deducted) ?
				flt(this.frm.doc.grand_total * this.frm.doc.conversion_rate) : this.frm.doc.base_net_total);


		}

		this.frm.doc.total_taxes_and_charges = flt(this.frm.doc.grand_total - this.frm.doc.net_total
			- flt(this.frm.doc.rounding_adjustment), precision("total"));


		// Round grand total as per precision
//		frappe.model.round_floats_in(this.frm.doc, ["grand_total", "base_grand_total"]);

		// rounded totals
		this.set_rounded_total();
	},

	set_rounded_total: function() {
		var disable_rounded_total = 0;
		if(frappe.meta.get_docfield(this.frm.doc.doctype, "disable_rounded_total", this.frm.doc.name)) {
			disable_rounded_total = this.frm.doc.disable_rounded_total;
		} else if (frappe.sys_defaults.disable_rounded_total) {
			disable_rounded_total = frappe.sys_defaults.disable_rounded_total;
		}

		if (cint(disable_rounded_total)) {
			this.frm.doc.rounded_total = 0;
			this.frm.doc.base_rounded_total = 0;
			return;
		}

		if(frappe.meta.get_docfield(this.frm.doc.doctype, "rounded_total", this.frm.doc.name)) {
			this.frm.doc.rounded_total = round_based_on_smallest_currency_fraction(this.frm.doc.grand_total,
				this.frm.doc.currency, precision("rounded_total"));
			this.frm.doc.rounding_adjustment += flt(this.frm.doc.rounded_total - this.frm.doc.grand_total,
				precision("rounding_adjustment"));
		}
	},

	_cleanup: function() {
		this.frm.doc.base_in_words = this.frm.doc.in_words = "";

		if(this.frm.doc["items"] && this.frm.doc["items"].length) {
			if(!frappe.meta.get_docfield(this.frm.doc["items"][0].doctype, "item_tax_amount", this.frm.doctype)) {
				$.each(this.frm.doc["items"] || [], function(i, item) {
					delete item["item_tax_amount"];
				});
			}
		}

		if(this.frm.doc["taxes"] && this.frm.doc["taxes"].length) {
			var temporary_fields = ["tax_amount_for_current_item", "grand_total_for_current_item",
				"tax_fraction_for_current_item", "grand_total_fraction_for_current_item"];

			if(!frappe.meta.get_docfield(this.frm.doc["taxes"][0].doctype, "tax_amount_after_discount_amount", this.frm.doctype)) {
				temporary_fields.push("tax_amount_after_discount_amount");
			}

			$.each(this.frm.doc["taxes"] || [], function(i, tax) {
				$.each(temporary_fields, function(i, fieldname) {
					delete tax[fieldname];
				});

				if (!tax.dont_recompute_tax) {
					tax.item_wise_tax_detail = JSON.stringify(tax.item_wise_tax_detail);
				}
			});
		}
	},


	apply_discount_amount: function() {
		var me = this;
		var distributed_amount = 0.0;
		this.frm.doc.base_discount_amount = 0.0;

		if (this.frm.doc.discount_amount) {
			if(!this.frm.doc.apply_discount_on)
				frappe.throw(__("Please select Apply Discount On"));

			this.frm.doc.base_discount_amount = flt(this.frm.doc.discount_amount * this.frm.doc.conversion_rate,
				precision("base_discount_amount"));

			var total_for_discount_amount = this.get_total_for_discount_amount();
			var net_total = 0;
			// calculate item amount after Discount Amount
			if (total_for_discount_amount) {
				$.each(this.frm.doc["items"] || [], function(i, item) {
					distributed_amount = flt(me.frm.doc.discount_amount) * item.net_amount / total_for_discount_amount;
					item.net_amount = flt(item.net_amount - distributed_amount,
						precision("base_amount", item));
					net_total += item.net_amount;

					// discount amount rounding loss adjustment if no taxes
					if ((!(me.frm.doc.taxes || []).length || total_for_discount_amount==me.frm.doc.net_total || (me.frm.doc.apply_discount_on == "Net Total"))
							&& i == (me.frm.doc.items || []).length - 1) {
						var discount_amount_loss = flt(me.frm.doc.net_total - net_total
							- me.frm.doc.discount_amount, precision("net_total"));
						item.net_amount = flt(item.net_amount + discount_amount_loss,
							precision("net_amount", item));
					}
					item.net_rate = item.qty ? flt(item.net_amount / item.qty, precision("net_rate", item)) : 0;
				});

				this.discount_amount_applied = true;
				this._calculate_taxes_and_totals();
			}
		}
	},

	get_total_for_discount_amount: function() {
		if(this.frm.doc.apply_discount_on == "Net Total") {
			return this.frm.doc.net_total;
		} else {
			var total_actual_tax = 0.0;
			var actual_taxes_dict = {};

			$.each(this.frm.doc["taxes"] || [], function(i, tax) {
				if (in_list(["Actual", "On Item Quantity"], tax.charge_type)) {
					var tax_amount = (tax.category == "Valuation") ? 0.0 : tax.tax_amount;
					tax_amount *= (tax.add_deduct_tax == "Deduct") ? -1.0 : 1.0;
					actual_taxes_dict[tax.idx] = tax_amount;
				} else if (actual_taxes_dict[tax.row_id] !== null) {
					var actual_tax_amount = flt(actual_taxes_dict[tax.row_id]) * flt(tax.rate) / 100;
					actual_taxes_dict[tax.idx] = actual_tax_amount;
				}
			});

			$.each(actual_taxes_dict, function(key, value) {
				if (value) total_actual_tax += value;
			});

			return flt(this.frm.doc.grand_total - total_actual_tax, precision("grand_total"));
		}
	},

	set_default_payment: function(total_amount_to_pay, update_paid_amount) {
		var me = this;
		var payment_status = true;
		if(this.frm.doc.is_pos && (update_paid_amount===undefined || update_paid_amount)) {
			$.each(this.frm.doc['payments'] || [], function(index, data) {
				if(data.default && payment_status && total_amount_to_pay > 0) {
					let base_amount = flt(total_amount_to_pay, precision("base_amount", data));
					frappe.model.set_value(data.doctype, data.name, "base_amount", base_amount);
					let amount = flt(total_amount_to_pay / me.frm.doc.conversion_rate, precision("amount", data));
					frappe.model.set_value(data.doctype, data.name, "amount", amount);
					payment_status = false;
				} else if(me.frm.doc.paid_amount) {
					frappe.model.set_value(data.doctype, data.name, "amount", 0.0);
				}
			});
		}
	},
});
