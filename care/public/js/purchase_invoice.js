frappe.ui.form.on('Purchase Invoice', {
    refresh: function(frm, cdt, cdn) {
        validate_item_rate(frm, cdt, cdn)
        if(!frm.doc__islocal && frm.doc.docstatus == 0)
        {
            frm.set_df_property('update_price_rate', 'hidden', 0);
            frm.fields_dict.update_price_rate.$input.addClass("btn-primary");
        }
        else{
            frm.set_df_property('update_price_rate', 'hidden', 1);
        }
	},
	onload: function(frm, cdt, cdn){
	     validate_item_rate(frm, cdt, cdn)
	},
	validate: function(frm, cdt, cdn){
	     validate_item_rate(frm, cdt, cdn)
	},
	update_price_rate: function(frm, cdt, cdn){
	    frappe.run_serially([
            () => frm.doc.items.forEach(function(item) {
                if(item.rate != item.price_list_rate){
                    let c_rate = item.rate;
                    frm.call({
                        method: "care.hook_events.purchase_invoice.get_price_list_rate_for",
                        args: {
                            item_code: item.item_code,
                            args: {
                                item_code: item.item_code,
                                barcode: item.barcode,
                                serial_no: item.serial_no,
                                batch_no: item.batch_no,
                                set_warehouse: frm.doc.set_warehouse,
                                warehouse: item.warehouse,
                                customer: frm.doc.customer || frm.doc.party_name,
                                quotation_to: frm.doc.quotation_to,
                                supplier: frm.doc.supplier,
                                currency: frm.doc.currency,
                                update_stock: frm.doc.update_stock,
                                conversion_rate: frm.doc.conversion_rate,
                                price_list: frm.doc.selling_price_list || frm.doc.buying_price_list,
                                price_list_currency: frm.doc.price_list_currency,
                                plc_conversion_rate: frm.doc.plc_conversion_rate,
                                company: frm.doc.company,
                                order_type: frm.doc.order_type,
                                is_pos: cint(frm.doc.is_pos),
                                is_return: cint(frm.doc.is_return),
                                is_subcontracted: frm.doc.is_subcontracted,
                                transaction_date: frm.doc.transaction_date || frm.doc.posting_date,
                                ignore_pricing_rule: frm.doc.ignore_pricing_rule,
                                doctype: frm.doc.doctype,
                                name: frm.doc.name,
                                project: item.project || frm.doc.project,
                                qty: item.qty || 1,
                                net_rate: item.rate,
                                stock_qty: item.stock_qty,
                                conversion_factor: item.conversion_factor,
                                weight_per_unit: item.weight_per_unit,
                                weight_uom: item.weight_uom,
                                manufacturer: item.manufacturer,
                                stock_uom: item.stock_uom,
                                pos_profile: cint(frm.doc.is_pos) ? frm.doc.pos_profile : '',
                                cost_center: item.cost_center,
                                tax_category: frm.doc.tax_category,
                                item_tax_template: item.item_tax_template,
                                child_docname: item.name
                            }
                        },
                        callback: function(r) {
                            frappe.run_serially([
                                () => frappe.model.set_value(item.doctype, item.name, 'price_list_rate',r.message),
                                () => frappe.model.set_value(item.doctype, item.name, 'rate',c_rate)
                            ]);
                        }
                    })
                }
            }),
            () => frm.save()
        ])
	}
});

function validate_item_rate(frm, cdt, cdn){
    cur_frm.fields_dict["items"].$wrapper.find('.grid-body .rows').find(".grid-row").each(function(i, item) {
        let d = locals[cur_frm.fields_dict["items"].grid.doctype][$(item).attr('data-name')];
        if( d['price_list_rate'] - 1 <= d["rate"] && d["rate"] <= d['price_list_rate'] + 1){
            $(item).find('.grid-static-col').css({'background-color': '#ffffff'});
        }
        else{
            $(item).find('.grid-static-col').css({'background-color': '#ffff80'});
        }
    });
}