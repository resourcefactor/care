// Copyright (c) 2021, RF and contributors
// For license information, please see license.txt

{% include 'care/public/js/tax_contoller.js' %};

//cur_frm.cscript.tax_table = "Purchase Taxes and Charges";

//{% include 'erpnext/accounts/doctype/purchase_taxes_and_charges_template/purchase_taxes_and_charges_template.js' %}

frappe.provide("care.care");

frappe.ui.form.on('Order Receiving', {
	setup: function(frm, cdt, cdn) {
	    if (frm.doc.__islocal) {
			frm.set_value("posting_date", frappe.datetime.now_date())
		}
		frm.set_value("buying_price_list", frappe.defaults.get_default('buying_price_list'))
		frm.set_value("currency", frappe.defaults.get_default('Currency'))
		frm.set_value("base_selling_price_list", frappe.defaults.get_default('selling_price_list'))
        frm.set_query("warehouse", () => {
			return {
				"filters": {
					"is_group": 0
				}
			};
		})
		frm.set_query("c_b_warehouse", () => {
			return {
				"filters": {
					"is_group": 0
				}
			};
		})
		frm.set_query("purchase_request", () => {
			return {
				"filters": {
					"docstatus": 1,
					"date": frm.doc.posting_date,
					"status": 'Open'
				}
			};
		})
		frm.set_query("supplier", function() {
            return {
                query: "care.care.doctype.purchase_invoice_creation_tool.purchase_invoice_creation_tool.get_supplier",
                filters: {'purchase_request': frm.doc.purchase_request}
            }
        });
	    frm.set_query("taxes_and_charges", function() {
			return {
				filters: {'company': frm.doc.company }
			}
		});
	},
	refresh: function(frm, cdt, cdn){
	    if (frm.doc.__islocal) {
			frm.set_value("posting_date", frappe.datetime.now_date())
		}
		if(!frm.doc.base_selling_price_list){
            frm.set_value("base_selling_price_list", frappe.defaults.get_default('selling_price_list'))
        }
		apply_item_filters(frm)
		parent_item_filters(frm)

        frm.fields_dict.add_items.$input.addClass("btn-primary");
        frm.fields_dict.validate_data.$input.addClass("btn-primary");

		frm.get_field("items").grid.toggle_display("split_qty", frm.doc.warehouse ? 0 : 1);
		frm.get_field("items").grid.toggle_display("received_qty", frm.doc.is_return ? 1 : 0);
		frm.get_field("items").grid.toggle_enable("rate", frm.doc.update_buying_price ? 1 : 0);
	    refresh_field("items");
	    validate_item_rate(frm, cdt, cdn)

        if (frm.doc.status == 'Submitted'){
            frm.add_custom_button(__('Return'), function(){
                 make_return_entry(frm);

            }, __('Create'));

            frappe.call({
                method: "check_purchase_receipt_created",
                doc: frm.doc,
                freeze: true,
                callback: function(r) {
                    if(!r.message){
                        frm.add_custom_button(__('Purchase Receipt'), function(){
                        frappe.call({
                            method: "create_purchase_receipt",
                            doc: frm.doc,
                            freeze: true,
                            callback: function(r) {
                                frappe.set_route('List', 'Purchase Receipt', {order_receiving: frm.doc.name});
                            }
                        });
                        }, __('Create'));
                    }
                }
            });
            frm.add_custom_button(__('Order Receive Qty Report'), function(){
                 frappe.set_route('query-report', 'Order Receive Qty', {order_receiving: frm.doc.name});
            }, __('View'));
        }
        frm.page.set_inner_btn_group_as_primary(__('Create'));
	},
	warehouse: function(frm, cdt, cdn){
	    frm.get_field("items").grid.toggle_display("split_qty", frm.doc.warehouse ? 0 : 1);
	    refresh_field("items");
	},
	update_buying_price: function(frm, cdt, cdn){
		frm.get_field("items").grid.toggle_enable("rate", frm.doc.update_buying_price ? 1 : 0);
	    refresh_field("items");
	    if(!frm.doc.update_buying_price){
	        $.each(frm.doc['items'] || [], function(i, item) {
                frm.call({
                    method: "care.hook_events.purchase_invoice.get_price_list_rate_for",
                    args: {
                        item_code: item.item_code,
                        args: {
                            item_code: item.item_code,
                            supplier: frm.doc.supplier,
                            currency: frm.doc.currency,
                            price_list: frm.doc.buying_price_list,
                            price_list_currency: frm.doc.currency,
                            company: frm.doc.company,
                            transaction_date: frm.doc.posting_date ,
                            doctype: frm.doc.doctype,
                            name: frm.doc.name,
                            qty: item.qty || 1,
                            child_docname: item.name,
                            uom: item.uom,
                            stock_uom: item.stock_uom,
                            conversion_factor: item.conversion_factor
                        }
                    },
                    callback: function(r) {
                        item.rate = r.message || 0
                        let amt = item.rate * item.qty
                        let discount_amount = (amt / 100) * item.discount_percent
                        let amount = amt - discount_amount
                        let dis_aft_rate = amount/ item.qty
                        item.amount = amount
                        item.net_amount = amount
                        item.base_net_amount = amount
                        item.discount = discount_amount
                        item.discount_after_rate = dis_aft_rate
                    }
                })
            });
	    }
	},
	validate: function(frm, cdt, cdn){
	    frm.trigger('validate_datas');
        $.each(frm.doc.items,  function(i,  d) {
            d.amount_before_discount = d.rate * d.qty;
        });
	    validate_item_rate(frm, cdt, cdn)
	},
    purchase_request: function (frm){
	    apply_item_filters(frm)
	    parent_item_filters(frm)
    },
    supplier: function (frm){
	    apply_item_filters(frm)
	    parent_item_filters(frm)
    },
    accept_un_order_item: function (frm){
	    apply_item_filters(frm)
	    parent_item_filters(frm)
    },
    onload: function (frm, cdt, cdn){
	    validate_item_rate(frm, cdt, cdn)
		frm.get_field("items").grid.toggle_display("received_qty", frm.doc.is_return ? 1 : 0);

		frappe.ui.keys.on("ctrl+z", () => {
            frappe.call({
                method: "get_item_code",
                doc: frm.doc,
                callback: function(r) {
                    frappe.run_serially([
                        ()=>{
                            if (!frm.doc.accept_un_order_item){
                                frm.fields_dict['items'].grid.get_field("item_code").get_query = function(doc, cdt, cdn) {
                                    return {
                                        filters: {'name':['in',r.message]}
                                    }
                                }
                            }
                            else{
                                frm.fields_dict['items'].grid.get_field("item_code").get_query = function (doc, cdt, cdn) {
                                    var child = locals[cdt][cdn];
                                    return {
                                        filters: {'name':['not in',r.message]}
                                    }
                                }
                            }
                        },
                        ()=>{
                            var new_row = frm.fields_dict.items.grid;
                            new_row.add_new_row(null, null, true, null, true);
                            new_row.grid_rows[new_row.grid_rows.length - 1].toggle_editable_row();
                            new_row.set_focus_on_row();
                        }
                    ])
                }
            });
		});
    },
    validate_data: function(frm, cdt, cdn){
        frappe.run_serially([
            ()=>frm.trigger('validate_datas'),
            ()=>frm.save()
        ])
    },
    validate_datas: function(frm, cdt, cdn){
        frappe.run_serially([
            ()=>{
                $.each(frm.doc['items'] || [], function(i, item) {
                    if (item.rate <= 0 || item.conversion_factor == 0){
                        frm.call({
                            method: "care.care.doctype.order_receiving.order_receiving.get_items_details",
                            args: {
                                item_code: item.item_code,
                                doc: frm.doc,
                                item: item
                            },
                            callback: function(r) {
                                item.conversion_factor = r.message.conversion_factor || 1
                                item.qty = r.message.qty || 1
                                item.rate = r.message.buying_price_rate || 0
                                item.net_rate = r.message.buying_price_rate || 0
                                item.base_net_rate = r.message.buying_price_rate || 0
                                item.base_buying_price_list_rate = r.message.buying_price_rate || 0
                                item.selling_price_list_rate = r.message.selling_price_rate || 0
                                item.base_selling_price_list_rate = r.message.selling_price_rate || 0
                                item.discount_percent = r.message.discount_percentage || 0
                                item.discount = r.message.discount_amount || 0

                                let margin = -100;
                                if (r.message.selling_price_rate > 0){
                                    margin = (r.message.selling_price_rate - r.message.buying_price_rate) / r.message.selling_price_rate * 100;
                                }
                                item.margin =  margin
                                let amt = item.rate * item.qty
                                let discount_amount = (amt / 100) * item.discount_percent
                                let amount = amt - discount_amount
                                let dis_aft_rate = amount/ item.qty
                                item.discount = discount_amount
                                item.amount = amount
                                item.net_amount = amount
                                item.base_net_amount = amount
                                item.discount_after_rate = dis_aft_rate
                            }
                        })
                    }
                })
            },
            ()=>update_total_qty(frm, cdt, cdn)
        ])
    }
});

function validate_item_rate(frm, cdt, cdn){
    cur_frm.fields_dict["items"].$wrapper.find('.grid-body .rows').find(".grid-row").each(function(i, item) {
        let d = locals[cur_frm.fields_dict["items"].grid.doctype][$(item).attr('data-name')];
        if( d['base_buying_price_list_rate'] - 1 <= d["rate"] && d["rate"] <= d['base_buying_price_list_rate'] + 1){
            $(item).find('.grid-static-col').css({'background-color': '#ffffff'});
        }
        else{
            $(item).find('.grid-static-col').css({'background-color': '#ffff80'});
        }
    });
}

function parent_item_filters(frm){
    frappe.call({
        method: "get_item_code",
        doc: frm.doc,
        callback: function(r) {
           frm.set_query("item", () => {
                return {
                    filters: {'name':['in',r.message]}
                }
           })
        }
    });
}

function apply_item_filters(frm){
    frappe.call({
        method: "get_item_code",
        doc: frm.doc,
        callback: function(r) {
            if (!frm.doc.accept_un_order_item){
                frm.fields_dict['items'].grid.get_field("item_code").get_query = function(doc, cdt, cdn) {
                    return {
                        filters: {'name':['in',r.message]}
                    }
                }
            }
            else{
                frm.fields_dict['items'].grid.get_field("item_code").get_query = function (doc, cdt, cdn) {
                    var child = locals[cdt][cdn];
                    return {
                        filters: {'name':['not in',r.message]}
                    }
                }
            }
        }
    });
}

function apply_child_btn_color(frm, cdt, cdn){
    frm.fields_dict["items"].$wrapper.find('.grid-body .rows').find(".grid-row").each(function(i, item) {
        $(item).find('.grid-static-col').find('.field-area').find('.form-group').find('.btn').css({'background-color': ' #2690ef','color': 'white'});
    });
    refresh_field("split_qty", cdn, "items");
}

frappe.ui.form.on('Order Receiving Item', {
//    items_add: function(frm, cdt, cdn){
//        apply_item_filters(frm)
//    },
    item_code: function(frm, cdt, cdn){
        var row = locals[cdt][cdn];
        if(!frm.doc.purchase_request || !frm.doc.supplier){
            frm.fields_dict["items"].grid.grid_rows[row.idx - 1].remove();
            frappe.msgprint(__("Select supplier first."))
        }
        else{
            if (row.item_code){
//                get_items_details(frm, cdt, cdn)
                frappe.run_serially([
                    ()=>get_items_details(frm, cdt, cdn),
                    ()=>frappe.timeout(0.3),
                    ()=> {
                        frappe.call({
                            method: "get_item_code",
                            doc: frm.doc,
                            callback: function(r) {
                                frappe.run_serially([
                                    ()=>{
                                         if (!frm.doc.accept_un_order_item){
                                            frm.fields_dict['items'].grid.get_field("item_code").get_query = function(doc, cdt, cdn) {
                                                return {
                                                    filters: {'name':['in',r.message]}
                                                }
                                            }
                                        }
                                        else{
                                            frm.fields_dict['items'].grid.get_field("item_code").get_query = function (doc, cdt, cdn) {
                                                var child = locals[cdt][cdn];
                                                return {
                                                    filters: {'name':['not in',r.message]}
                                                }
                                            }
                                        }
                                    },
                                    ()=>{
                                        var new_row = frm.fields_dict.items.grid;
                                        new_row.add_new_row(null, null, true, null, true);
                                        new_row.grid_rows[new_row.grid_rows.length - 1].toggle_editable_row();
                                        new_row.set_focus_on_row();
                                    }
                                ])
                            }
                        });
                    }
                ])
            }
        }
    },
    qty: function(frm, cdt, cdn) {
        var row = locals[cdt][cdn];
        update_amount(frm, cdt, cdn)
        update_total_qty(frm, cdt, cdn)
	},
    rate: function(frm, cdt, cdn) {
        var row = locals[cdt][cdn];
        frappe.model.set_value(cdt,cdn,"net_rate",row.rate);
        frappe.model.set_value(cdt,cdn,"base_net_rate",row.rate);
        update_amount(frm, cdt, cdn)
        update_total_qty(frm, cdt, cdn)
        calculate_margin(frm, cdt, cdn)
	},
    discount: function(frm, cdt, cdn) {
        var row = locals[cdt][cdn];
        let amt = row.rate * row.qty
        let discount_per = (row.discount / amt) * 100
        row.discount_percent = discount_per
        refresh_field("discount_percent", cdn, "items");
        update_amount(frm, cdt, cdn)
	},
	uom: function(frm, cdt, cdn){
        var row = locals[cdt][cdn];
        get_items_details(frm, cdt, cdn)
    },
    discount_percent: function(frm, cdt, cdn) {
        var row = locals[cdt][cdn];
        let amt = row.rate * row.qty
        let discount_amount = (amt / 100) * row.discount_percent
        row.discount = discount_amount
        refresh_field("discount", cdn, "items");
        update_amount(frm, cdt, cdn)
	},
    selling_price_list_rate: function(frm, cdt, cdn) {
        calculate_margin(frm, cdt, cdn)
	},
	split_qty: function(frm, cdt, cdn) {
        var row = locals[cdt][cdn];
        frappe.call({
            method: "care.care.doctype.order_receiving.order_receiving.get_warehouse",
            args: {
                purchase_request:frm.doc.purchase_request,
                item:row.item_code
            },
            callback: function(r) {
                split_warehouse_wise_qty(row, frm, cdt, cdn, r.message)
            }
        });

	}
})

function update_amount(frm, cdt, cdn){
    var row = locals[cdt][cdn];
    let amt = row.rate * row.qty
    let discount_amount = (amt / 100) * row.discount_percent
    let amount = amt - discount_amount
    let dis_aft_rate = amount/ row.qty
    row.discount = discount_amount
    row.amount = amount
    row.net_amount = amount
    row.base_net_amount = amount
    row.discount_after_rate = dis_aft_rate

    frm.refresh_field("items");
}
function update_total_qty(frm, cdt, cdn){
    let total_qty = 0
    let total_amt = 0
    $.each(frm.doc['items'] || [], function(i, row) {
        total_qty = total_qty + row.qty
        total_amt = total_amt + row.amount
    });
    frm.set_value("total_qty", total_qty);
    frm.set_value("total", total_amt);
    frm.set_value("grand_total", total_amt);
}

function calculate_margin(frm, cdt, cdn){
     var item = locals[cdt][cdn];
     let margin = -100;
     if (item.selling_price_list_rate > 0){
        margin = (item.selling_price_list_rate - item.rate) / item.selling_price_list_rate * 100;
     }
     frappe.model.set_value( cdt, cdn, 'margin_percent',margin)
}


function get_items_details(frm, cdt, cdn){
//    console.log("----------get_items_details-----------------")
    var item = locals[cdt][cdn];
    frm.call({
        method: "care.care.doctype.order_receiving.order_receiving.get_items_details",
        args: {
            item_code: item.item_code,
            doc: frm.doc,
            item: item
        },
        freeze: true,
        callback: function(r) {
            item.conversion_factor = r.message.conversion_factor || 1
            item.qty = r.message.qty || 1
            item.rate = r.message.buying_price_rate || 0
            item.net_rate = r.message.buying_price_rate || 0
            item.base_net_rate = r.message.buying_price_rate || 0
            item.base_buying_price_list_rate = r.message.buying_price_rate || 0
            item.selling_price_list_rate = r.message.selling_price_rate || 0
            item.base_selling_price_list_rate = r.message.selling_price_rate || 0
            item.discount_percent = r.message.discount_percentage || 0
            item.discount = r.message.discount_amount || 0
//            refresh_field("conversion_factor", cdn, "items");

            let margin = -100;
            if (r.message.selling_price_rate > 0){
                margin = (r.message.selling_price_rate - r.message.buying_price_rate) / r.message.selling_price_rate * 100;
            }
            item.margin =  margin
            update_amount(frm, cdt, cdn)
            update_total_qty(frm, cdt, cdn)
            if(r.message.item_tax_template){
                frappe.model.set_value(cdt,cdn,"item_tax_template", r.message.item_tax_template);
            }
        }
    })
}

function split_warehouse_wise_qty(row, frm, cdt, cdn, warhs){
    let data = JSON.parse(row.code || '[]')
    if (data.length === 0){
        data = warhs;
    }
    let dialog = new frappe.ui.Dialog({
        title: __('Split Qty'),
        fields: [
            {
                fieldtype: 'Data',
                fieldname: 'item',
                 label: __('Item'),
                read_only: 1,
                default: row.item_code + ":" + row.item_name
            },
            { fieldtype: "Column Break" },
            {
                fieldtype: 'Float',
                fieldname: 'qty',
                label: __('Qty'),
                default: row.qty,
                read_only: 1
            },
            { fieldtype: "Section Break" },
            {
                fieldname: 'split_data',
                fieldtype: 'Table',
                label: __('Warehouses'),
                in_editable_grid: true,
                reqd: 1,
                fields: [{
                    fieldtype: 'Link',
                    fieldname: 'warehouse',
                    options: 'Warehouse',
                    in_list_view: 1,
                    label: __('Warehouse'),
                    columns: 4,
                    get_query: () => {
                        return {
                            filters: {
                                "is_group": 0
                            }
                        };
                    }
                }, {
                    fieldtype: 'Read Only',
                    fieldname: 'order_qty',
                    label: __('Order Qty'),
                    in_list_view: 1,
                    columns: 2
                }, {
                    fieldtype: 'Float',
                    fieldname: 'qty',
                    label: __('Qty'),
                    in_list_view: 1,
                    reqd: 1,
                    default: 0,
                    columns: 2
                }],
                data: data
            },
        ],
        primary_action_label: __('Save'),
        primary_action: function(values) {
            let child_data = values.split_data;
            let t_qty = 0
            let lst = []
            child_data.forEach((d) => {
                t_qty = t_qty + d.qty
                lst.push({"warehouse": d.warehouse, "order_qty": d.order_qty, "qty": d.qty})
            });
            if (values.qty != t_qty){
                frappe.throw(__("Total split qty must be equal to ") + values.qty);
            }
            else{
                dialog.hide();
                frappe.model.set_value(cdt,cdn,"code",JSON.stringify(lst));
                refresh_field("code", cdn, "items");
            }
        }
    });
    dialog.show();
}

function make_return_entry(frm){
    frm.call({
        method: "get_item_filter",
        doc: frm.doc,
        callback: function(r) {
            var items = r.message;
            let dialog = new frappe.ui.Dialog({
                title: __('Return'),
                fields: [
                    {
                        fieldname: 'items',
                        fieldtype: 'Table',
                        label: __('Items'),
                        in_editable_grid: true,
                        reqd: 1,
                        fields: [{
                            fieldtype: 'Link',
                            fieldname: 'item_code',
                            options: 'Item',
                            in_list_view: 1,
                            label: __('Item Code'),
                            columns: 2,
                            get_query: () => {
                                return {
                                    filters: {
                                        "name": ['in', items]
                                    }
                                };
                            },
                            change: function() {
                                var me = this;
                                var item_code = me.get_value();
                                if(item_code){
                                    frappe.db.get_value('Item', item_code, 'item_name', function(value) {
                                        me.grid_row.on_grid_fields_dict.item_name.set_value(value['item_name']);
                                    });

                                    frappe.call({
                                        method: 'care.care.doctype.order_receiving.order_receiving.get_total_receive_qty',
                                        args: {
                                            doc_name: frm.doc.name,
                                            item: item_code
                                        },
                                        callback: (r) => {
                                            me.grid_row.on_grid_fields_dict.rec_qty.set_value(r.message.qty || 0);
                                            me.grid_row.on_grid_fields_dict.return_qty.set_value(r.message.qty || 0);
                                            me.grid_row.on_grid_fields_dict.rate.set_value(r.message.rate || 0);
                                        }
                                    });
                                }
                                else{
                                    me.grid_row.on_grid_fields_dict.item_name.set_value('');
                                    me.grid_row.on_grid_fields_dict.rec_qty.set_value(0);
                                    me.grid_row.on_grid_fields_dict.return_qty.set_value(0);
                                    me.grid_row.on_grid_fields_dict.rate.set_value(0);
                                }
                            }
                        },
                        {
                            fieldtype: 'Read Only',
                            fieldname: 'item_name',
                            label: __('Item Name'),
                            in_list_view: 1,
                            columns: 2
                        },
                        {
                            fieldtype: 'Read Only',
                            fieldname: 'rec_qty',
                            label: __('Receive Qty'),
                            in_list_view: 1,
                            columns: 2
                        },
                        {
                            fieldtype: 'Float',
                            fieldname: 'return_qty',
                            label: __('Return Qty'),
                            in_list_view: 1,
                            reqd: 1,
                            default: 0,
                            columns: 2
                        },
                        {
                            fieldtype: 'Read Only',
                            fieldname: 'rate',
                            label: __('Rate'),
                            in_list_view: 1,
                            columns: 2
                        },]
                    },
                ],
                primary_action_label: __('create'),
                primary_action: function(values) {
                    let child_data = values.items;
                    frm.call({
                        method: "care.care.doctype.order_receiving.order_receiving.make_return_entry",
                        args: {
                            doc_name: frm.doc.name,
                            items: child_data
                        },
                        callback: function(r) {
                            if(r.message){
                                var doclist = frappe.model.sync(r.message);
					            frappe.set_route("Form", doclist[0].doctype, doclist[0].name);
                            }
                        }
                    })
                    let t_qty = 0
                    let lst = []
                    child_data.forEach((d) => {
                        t_qty = t_qty + d.qty
                        lst.push({"warehouse": d.warehouse, "order_qty": d.order_qty, "qty": d.qty})
                    });
                    if (values.qty != t_qty){
                        frappe.throw(__("Total split qty must be equal to ") + values.qty);
                    }
                    else{
                        dialog.hide();
                        frappe.model.set_value(cdt,cdn,"code",JSON.stringify(lst));
                        refresh_field("code", cdn, "items");
                    }
                }
            });
            dialog.show();
        }
    });
}
// for backward compatibility: combine new and previous states
$.extend(cur_frm.cscript, new care.care.ReceivingController({frm: cur_frm}));